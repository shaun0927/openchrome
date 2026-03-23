/**
 * ChromePool - Manages multiple Chrome instances on different ports
 * to solve the CDP same-origin renderer process contention issue.
 * Also supports profile-aware instance routing for multi-profile workflows.
 */

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ChromeLauncher, ChromeInstance, LaunchOptions } from './launcher';
import { ProfileManager } from './profile-manager';

export interface ChromePoolConfig {
  maxInstances: number; // default: 5
  basePort: number;     // default: 9222
  autoLaunch: boolean;
}

export interface PooledInstance {
  port: number;
  launcher: ChromeLauncher;
  origins: Set<string>;  // origins currently using this instance
  tabCount: number;
  isPreExisting: boolean; // was it already running when we found it?
  profileDirectory?: string; // Chrome profile directory (e.g., "Profile 1", "Default")
}

const DEFAULT_POOL_CONFIG: ChromePoolConfig = {
  maxInstances: 5,
  basePort: 9222,
  autoLaunch: false,
};

/**
 * Check if a Chrome debug port is responding
 */
async function checkDebugPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/version',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            JSON.parse(data);
            resolve(true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export class ChromePool {
  private config: ChromePoolConfig;
  private instances: Map<number, PooledInstance> = new Map();
  // In-flight dedup: prevent concurrent launches for the same profile (P1-3 fix)
  private profileLaunchInFlight: Map<string, Promise<PooledInstance>> = new Map();

  constructor(config: Partial<ChromePoolConfig> = {}) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /**
   * Acquire a Chrome instance that does NOT already have a tab open to the given origin.
   * If all instances have the origin, launch a new one (up to maxInstances).
   */
  async acquireInstance(origin: string): Promise<PooledInstance> {
    // 1. Find an existing instance that does NOT have this origin
    for (const [, instance] of this.instances) {
      if (!instance.origins.has(origin)) {
        instance.origins.add(origin);
        instance.tabCount++;
        console.error(
          `[ChromePool] Assigned origin "${origin}" to existing instance on port ${instance.port}`
        );
        return instance;
      }
    }

    // 2. All existing instances have this origin — try to launch a new one
    if (this.instances.size < this.config.maxInstances) {
      const newInstance = await this.launchNewInstance();
      newInstance.origins.add(origin);
      newInstance.tabCount++;
      console.error(
        `[ChromePool] Launched new instance on port ${newInstance.port} for origin "${origin}"`
      );
      return newInstance;
    }

    // 3. At capacity — fall back to the instance with the fewest tabs
    console.error(
      `[ChromePool] At max capacity (${this.config.maxInstances}). ` +
        `Assigning "${origin}" to least-loaded instance.`
    );
    let leastLoaded: PooledInstance | null = null;
    for (const [, instance] of this.instances) {
      if (!leastLoaded || instance.tabCount < leastLoaded.tabCount) {
        leastLoaded = instance;
      }
    }

    if (!leastLoaded) {
      throw new Error('[ChromePool] No instances available');
    }

    leastLoaded.origins.add(origin);
    leastLoaded.tabCount++;
    return leastLoaded;
  }

  /**
   * Acquire a Chrome instance running a specific profile.
   * Returns an existing instance if one is already running this profile,
   * otherwise launches a new Chrome process with --profile-directory.
   * Uses in-flight deduplication to prevent concurrent launches for the same profile.
   */
  async acquireInstanceForProfile(profileDirectory: string, origin?: string): Promise<PooledInstance> {
    // 1. Find an existing instance already running this profile
    for (const [, instance] of this.instances) {
      if (instance.profileDirectory === profileDirectory) {
        if (origin) instance.origins.add(origin);
        instance.tabCount++;
        console.error(
          `[ChromePool] Reusing existing instance on port ${instance.port} for profile "${profileDirectory}"`
        );
        return instance;
      }
    }

    // 2. Check for in-flight launch of the same profile (P1-3: race condition fix)
    const inflight = this.profileLaunchInFlight.get(profileDirectory);
    if (inflight) {
      console.error(`[ChromePool] Waiting for in-flight launch of profile "${profileDirectory}"`);
      const inst = await inflight;
      if (origin) inst.origins.add(origin);
      inst.tabCount++;
      return inst;
    }

    // 3. Validate that the profile exists in Chrome's Local State
    const profileManager = new ProfileManager();
    const knownProfiles = profileManager.listProfiles();
    const profileExists = knownProfiles.some(p => p.directory === profileDirectory);
    if (!profileExists) {
      const available = knownProfiles.map(p => `"${p.directory}" (${p.name})`).join(', ');
      throw new Error(
        `[ChromePool] Profile "${profileDirectory}" not found. ` +
        `Available profiles: ${available || 'none'}. ` +
        `Use list_profiles to see all available profiles.`
      );
    }

    // 4. No instance with this profile — launch a new one
    if (this.instances.size >= this.config.maxInstances) {
      throw new Error(
        `[ChromePool] Cannot launch Chrome for profile "${profileDirectory}": ` +
        `pool is at max capacity (${this.config.maxInstances} instances). ` +
        `Close unused profiles first.`
      );
    }

    // Set in-flight guard before async launch
    const launchPromise = this.launchNewInstance(profileDirectory).finally(() => {
      this.profileLaunchInFlight.delete(profileDirectory);
    });
    this.profileLaunchInFlight.set(profileDirectory, launchPromise);

    const newInstance = await launchPromise;
    if (origin) newInstance.origins.add(origin);
    newInstance.tabCount++;
    console.error(
      `[ChromePool] Launched new instance on port ${newInstance.port} for profile "${profileDirectory}"`
    );
    return newInstance;
  }

  /**
   * Mark that an origin is no longer using a port.
   */
  releaseInstance(port: number, origin: string): void {
    const instance = this.instances.get(port);
    if (!instance) {
      return;
    }
    const removed = instance.origins.delete(origin);
    if (removed && instance.tabCount > 0) {
      instance.tabCount--;
    }
    console.error(
      `[ChromePool] Released origin "${origin}" from port ${port}. ` +
        `Remaining origins: ${instance.tabCount}`
    );
  }

  /**
   * Decrement tab count for a profile instance (P1-2 fix).
   * Used when a profile worker is deleted but has no poolOrigin.
   */
  releaseProfileInstance(port: number): void {
    const instance = this.instances.get(port);
    if (!instance) return;
    if (instance.tabCount > 0) {
      instance.tabCount--;
    }
    console.error(
      `[ChromePool] Released profile instance on port ${port}. Tab count: ${instance.tabCount}`
    );
  }

  /**
   * Close all instances we launched (not pre-existing ones).
   */
  async cleanup(): Promise<void> {
    const closurePromises: Promise<void>[] = [];

    for (const [port, instance] of this.instances) {
      if (!instance.isPreExisting) {
        console.error(`[ChromePool] Closing launched instance on port ${port}`);
        closurePromises.push(instance.launcher.close());
      } else {
        console.error(
          `[ChromePool] Skipping pre-existing instance on port ${port}`
        );
      }
    }

    await Promise.all(closurePromises);
    this.instances.clear();
    this.profileLaunchInFlight.clear();
    console.error('[ChromePool] Cleanup complete.');
  }

  /**
   * Get all current pool instances (read-only snapshot).
   */
  getInstances(): ReadonlyMap<number, PooledInstance> {
    return this.instances;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async launchNewInstance(profileDirectory?: string): Promise<PooledInstance> {
    const port = this.nextAvailablePort();
    const launcher = new ChromeLauncher(port);

    // SingletonLock isolation: Chrome's SingletonLock is per --user-data-dir,
    // NOT per --profile-directory. Two Chrome processes sharing the same
    // --user-data-dir will conflict even with different --profile-directory.
    // Each profile instance gets its own isolated user-data-dir.
    const profileUserDataDir = profileDirectory
      ? path.join(os.homedir(), '.openchrome', 'profiles', profileDirectory.replace(/[^a-zA-Z0-9_\- ]/g, '_'))
      : undefined;

    const launchOptions: LaunchOptions = {
      port,
      autoLaunch: profileDirectory ? true : this.config.autoLaunch,
      ...(profileDirectory && { profileDirectory }),
      ...(profileUserDataDir && { userDataDir: profileUserDataDir }),
    };

    let isPreExisting = false;

    // Check if something is already on this port
    const alreadyRunning = await checkDebugPort(port);
    if (alreadyRunning) {
      console.error(
        `[ChromePool] Port ${port} already has Chrome running — treating as pre-existing.`
      );
      isPreExisting = true;
      // Still call ensureChrome so launcher caches the instance reference
      await launcher.ensureChrome(launchOptions);
    } else {
      await launcher.ensureChrome(launchOptions);
    }

    const pooled: PooledInstance = {
      port,
      launcher,
      origins: new Set(),
      tabCount: 0,
      isPreExisting,
      profileDirectory,
    };

    this.instances.set(port, pooled);
    return pooled;
  }

  private nextAvailablePort(): number {
    // Find the next port not already in use by our pool
    for (let offset = 0; offset < this.config.maxInstances + 10; offset++) {
      const candidate = this.config.basePort + offset;
      if (!this.instances.has(candidate)) {
        return candidate;
      }
    }
    // Fallback: use a high ephemeral port
    return this.config.basePort + this.instances.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let poolInstance: ChromePool | null = null;

export function getChromePool(config?: Partial<ChromePoolConfig>): ChromePool {
  if (!poolInstance) {
    poolInstance = new ChromePool(config);
  } else if (config && Object.keys(config).length > 0) {
    // P1-5: warn when config is passed to an already-initialized singleton
    console.error('[ChromePool] Warning: getChromePool called with config after initialization; config ignored.');
  }
  return poolInstance;
}

/** Reset the singleton — for tests only. */
export function resetChromePool(): void {
  poolInstance = null;
}
