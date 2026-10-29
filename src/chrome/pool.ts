/**
 * ChromePool - Manages multiple Chrome instances on different ports
 * to solve the CDP same-origin renderer process contention issue.
 * Also supports profile-aware instance routing for multi-profile workflows.
 */

import * as fs from 'fs';
import * as http from 'http';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { ChromeLauncher, LaunchOptions } from './launcher';
import { ProfileManager } from './profile-manager';
import { detectRunningChromes } from './process-detector';
import { killProcessTree } from './pid-manager';
import { defaultUserDataDir } from './auto-connect';
import { pinAttachUserDataDir } from './auto-connect-state';
import { probeDebugPort } from './launcher-debug-port';
import {
  readDevToolsActivePort,
  readSingletonLockPid,
  registerProfileUser,
  releaseProfileUser,
} from './profile-users';

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
  lastActiveAt: number; // timestamp of last tab activity (used by idle reaper)
  /**
   * OpenChrome-managed per-profile user-data-dir. Set when the Chrome may be
   * shared with other OpenChrome sessions; the last user closes it.
   */
  managedUserDataDir?: string;
  /**
   * The user's everyday Chrome, reached through `<dir>/DevToolsActivePort`
   * (chrome://inspect "Allow remote debugging"). One browser serves every
   * profile in it; tabs are opened per profile and the browser is never closed.
   */
  hostUserDataDir?: string;
}

/** Stable per-profile user-data-dir shared by every OpenChrome session. */
export function profileUserDataDir(profileDirectory: string): string {
  return path.join(os.homedir(), '.openchrome', 'profiles', profileDirectory.replace(/[^a-zA-Z0-9_\- ]/g, '_'));
}

interface RunningProfileChrome {
  port: number;
  managed: boolean;
  hostUserDataDir?: string;
}

/**
 * The user's everyday Chrome when remote debugging was allowed for it at
 * chrome://inspect/#remote-debugging. Its `/json/version` may answer 404, so
 * any HTTP answer (or a WebSocket-only listener) counts as alive.
 */
async function findDebuggableEverydayChrome(): Promise<RunningProfileChrome | null> {
  const dir = defaultUserDataDir();
  if (!dir) return null;
  const port = readDevToolsActivePort(dir);
  if (!port) return null;
  const probe = await probeDebugPort(port, 1500);
  if (probe.kind === 'network-error' || probe.kind === 'timeout') return null;
  return { port, managed: false, hostUserDataDir: dir };
}

/**
 * Find a Chrome already serving `profileDirectory` on a debug port: one an
 * OpenChrome session launched (any process), or one the user started with
 * `--profile-directory=<dir> --remote-debugging-port=<port>`.
 */
async function findRunningProfileChrome(profileDirectory: string): Promise<RunningProfileChrome | null> {
  const managedDir = profileUserDataDir(profileDirectory);
  const managedPort = readDevToolsActivePort(managedDir);
  if (managedPort && await checkDebugPort(managedPort)) {
    return { port: managedPort, managed: true };
  }

  let detected: ReturnType<typeof detectRunningChromes> = [];
  try {
    detected = detectRunningChromes();
  } catch {
    return null;
  }
  for (const chrome of detected) {
    if (chrome.profileDirectory !== profileDirectory || !chrome.hasDebugPort) continue;
    if (!isOwnedByCurrentUser(chrome.pid, chrome.userDataDir)) continue;
    const match = /--remote-debugging-port=(\d+)/.exec(chrome.cmdline);
    const port = match ? parseInt(match[1], 10) : 0;
    if (port > 0 && await checkDebugPort(port)) {
      const managed = !!chrome.userDataDir && path.resolve(chrome.userDataDir) === path.resolve(managedDir);
      return { port, managed };
    }
  }
  return null;
}

/**
 * A debug-port Chrome found by scanning the process table is trusted only when
 * this user owns both the process and its user-data-dir: another local user's
 * process (or a crafted command line) must not receive this user's session.
 * Windows has no uid; there the scan is left as before.
 */
function isOwnedByCurrentUser(pid: number, userDataDir: string | null): boolean {
  if (typeof process.getuid !== 'function') return true;
  const uid = process.getuid();
  try {
    const owner = parseInt(execFileSync('ps', ['-o', 'uid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(), 10);
    if (owner !== uid) return false;
    return !userDataDir || fs.statSync(userDataDir).uid === uid;
  } catch {
    return false;
  }
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
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly DEFAULT_REAPER_INTERVAL_MS = 60 * 1000; // check every 60s

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
        instance.lastActiveAt = Date.now();
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
      newInstance.lastActiveAt = Date.now();
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
    // 0. Only a directory listed in Chrome's Local State is accepted — it ends
    //    up in --profile-directory of a spawned or singleton-forwarded Chrome.
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

    // 1. Find an existing instance already running this profile
    for (const [, instance] of this.instances) {
      if (instance.profileDirectory === profileDirectory || instance.hostUserDataDir) {
        if (origin) instance.origins.add(origin);
        instance.tabCount++;
        instance.lastActiveAt = Date.now();
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
      inst.lastActiveAt = Date.now();
      return inst;
    }

    // 3. Attach to a Chrome already running this profile (another session's, or
    //    one the user started and signed into); otherwise launch a new one.
    //    Both happen under the in-flight guard so concurrent calls share one result.
    const launchPromise = this.attachOrLaunchProfile(profileDirectory).finally(() => {
      this.profileLaunchInFlight.delete(profileDirectory);
    });
    this.profileLaunchInFlight.set(profileDirectory, launchPromise);

    const newInstance = await launchPromise;
    if (origin) newInstance.origins.add(origin);
    newInstance.tabCount++;
    newInstance.lastActiveAt = Date.now();
    console.error(
      `[ChromePool] Using instance on port ${newInstance.port} for profile "${profileDirectory}"`
    );
    return newInstance;
  }

  private async attachOrLaunchProfile(profileDirectory: string): Promise<PooledInstance> {
    const running = await findDebuggableEverydayChrome() ?? await findRunningProfileChrome(profileDirectory);
    if (running && !this.instances.has(running.port)) {
      console.error(`[ChromePool] Found running Chrome on port ${running.port} for profile "${profileDirectory}"`);
      return this.attachRunningInstance(profileDirectory, running);
    }
    if (this.instances.size >= this.config.maxInstances) {
      throw new Error(
        `[ChromePool] Cannot launch Chrome for profile "${profileDirectory}": ` +
        `pool is at max capacity (${this.config.maxInstances} instances). ` +
        `Close unused profiles first.`
      );
    }
    return this.launchNewInstance(profileDirectory);
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
    instance.lastActiveAt = Date.now();
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
    instance.lastActiveAt = Date.now();
    console.error(
      `[ChromePool] Released profile instance on port ${port}. Tab count: ${instance.tabCount}`
    );
  }

  /**
   * Close all instances we launched (not pre-existing ones).
   */
  async cleanup(): Promise<void> {
    this.stopReaper();
    const closurePromises: Promise<void>[] = [];

    for (const [port, instance] of this.instances) {
      if (instance.managedUserDataDir) {
        this.releaseManagedInstance(port, instance, closurePromises);
      } else if (!instance.isPreExisting) {
        console.error(`[ChromePool] Closing launched instance on port ${port}`);
        closurePromises.push(
          instance.launcher.close().catch((err) => {
            console.error(`[ChromePool] Failed to close instance on port ${port}:`, err);
          })
        );
      } else {
        console.error(
          `[ChromePool] Skipping pre-existing instance on port ${port}`
        );
      }
    }

    // Use allSettled so one failed close() doesn't prevent cleaning up the rest
    await Promise.allSettled(closurePromises);
    this.instances.clear();
    this.profileLaunchInFlight.clear();
    console.error('[ChromePool] Cleanup complete.');
  }

  /**
   * Start the idle instance reaper.
   * Periodically checks for profile instances with tabCount === 0
   * that have been idle for longer than the threshold, and closes them.
   */
  startReaper(idleTimeoutMs: number = ChromePool.DEFAULT_IDLE_TIMEOUT_MS): void {
    if (this.reaperTimer) return; // already running

    this.reaperTimer = setInterval(() => {
      this.reapIdleInstances(idleTimeoutMs).catch((err) => {
        console.error('[ChromePool] Reaper error:', err);
      });
    }, ChromePool.DEFAULT_REAPER_INTERVAL_MS);
    this.reaperTimer.unref(); // don't prevent process exit
    console.error(`[ChromePool] Idle instance reaper started (timeout: ${idleTimeoutMs / 1000}s)`);
  }

  /**
   * Stop the idle instance reaper.
   */
  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
      console.error('[ChromePool] Idle instance reaper stopped');
    }
  }

  /**
   * Close idle profile instances.
   * An instance is considered idle if:
   * 1. It has tabCount === 0 (no active workers)
   * 2. It has been idle for longer than idleTimeoutMs
   * 3. It is not pre-existing (we don't close user-started Chrome)
   * 4. It has a profileDirectory (only profile instances are reaped, not origin-based)
   */
  private async reapIdleInstances(idleTimeoutMs: number): Promise<number> {
    const now = Date.now();
    let reaped = 0;

    for (const [port, instance] of this.instances) {
      if (
        instance.tabCount === 0 &&
        !instance.isPreExisting &&
        instance.profileDirectory &&
        (now - instance.lastActiveAt) > idleTimeoutMs
      ) {
        console.error(
          `[ChromePool] Reaping idle profile instance "${instance.profileDirectory}" on port ${port} ` +
          `(idle for ${Math.round((now - instance.lastActiveAt) / 1000)}s)`
        );
        if (instance.managedUserDataDir) {
          const closures: Promise<void>[] = [];
          this.releaseManagedInstance(port, instance, closures);
          await Promise.allSettled(closures);
        } else {
          try {
            await instance.launcher.close();
          } catch (err) {
            console.error(`[ChromePool] Failed to close idle instance on port ${port}:`, err);
          }
        }
        this.instances.delete(port);
        reaped++;
      }
    }

    if (reaped > 0) {
      console.error(`[ChromePool] Reaped ${reaped} idle instance(s)`);
    }

    return reaped;
  }

  /**
   * Synchronous exit path: release this process's claim on every instance and
   * return the Chrome PIDs this process must kill. Never includes Chromes the
   * user started, nor shared profile Chromes another live session still uses.
   */
  releaseAllForExit(): number[] {
    const pids: number[] = [];
    for (const [, instance] of this.instances) {
      if (instance.managedUserDataDir) {
        if (!releaseProfileUser(instance.managedUserDataDir)) continue;
        const pid = instance.launcher.getChromePid() ?? readSingletonLockPid(instance.managedUserDataDir);
        if (pid) pids.push(pid);
      } else if (!instance.isPreExisting && instance.launcher.getInstance?.()?.launchMode !== 'attach') {
        const pid = instance.launcher.getChromePid();
        if (pid) pids.push(pid);
      }
    }
    return pids;
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

  private async attachRunningInstance(profileDirectory: string, running: RunningProfileChrome): Promise<PooledInstance> {
    if (running.hostUserDataDir) pinAttachUserDataDir(running.port, running.hostUserDataDir);
    const launcher = new ChromeLauncher(running.port);
    await launcher.ensureChrome({ port: running.port, autoLaunch: false });
    const managedUserDataDir = running.managed ? profileUserDataDir(profileDirectory) : undefined;
    if (managedUserDataDir) registerProfileUser(managedUserDataDir);
    const pooled: PooledInstance = {
      port: running.port,
      launcher,
      origins: new Set(),
      tabCount: 0,
      isPreExisting: true,
      profileDirectory,
      lastActiveAt: Date.now(),
      ...(managedUserDataDir && { managedUserDataDir }),
      ...(running.hostUserDataDir && { hostUserDataDir: running.hostUserDataDir }),
    };
    this.instances.set(running.port, pooled);
    return pooled;
  }

  /**
   * Drop this process's claim on a shared profile Chrome; close it only when no
   * other live session uses it.
   */
  private releaseManagedInstance(port: number, instance: PooledInstance, closures: Promise<void>[]): void {
    const dir = instance.managedUserDataDir!;
    if (!releaseProfileUser(dir)) {
      console.error(`[ChromePool] Leaving shared profile instance on port ${port} running for other sessions`);
      return;
    }
    if (!instance.isPreExisting) {
      console.error(`[ChromePool] Closing launched instance on port ${port}`);
      closures.push(instance.launcher.close().catch((err) => {
        console.error(`[ChromePool] Failed to close instance on port ${port}:`, err);
      }));
      return;
    }
    // Attached to a Chrome another (now gone) session launched: we are the last user.
    const pid = readSingletonLockPid(dir);
    if (pid) {
      console.error(`[ChromePool] Closing shared profile instance on port ${port} (last user)`);
      try { killProcessTree(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  private async launchNewInstance(profileDirectory?: string): Promise<PooledInstance> {
    const port = await this.nextAvailablePort();
    const launcher = new ChromeLauncher(port);

    // SingletonLock isolation: Chrome's SingletonLock is per --user-data-dir,
    // NOT per --profile-directory. Two Chrome processes sharing the same
    // --user-data-dir will conflict even with different --profile-directory.
    // Each profile instance gets its own isolated user-data-dir.
    const managedUserDataDir = profileDirectory ? profileUserDataDir(profileDirectory) : undefined;

    // Sync cookies from the real Chrome profile into the isolated user-data-dir
    // so that profile instances start with up-to-date session data.
    if (profileDirectory && managedUserDataDir) {
      try {
        const profileManager = new ProfileManager();
        const realProfileDir = profileManager.getDefaultUserDataDir();
        if (realProfileDir && profileManager.needsSync(realProfileDir, profileDirectory)) {
          const result = profileManager.syncProfileData(realProfileDir, managedUserDataDir, profileDirectory);
          console.error(
            `[ChromePool] Cookie sync for profile "${profileDirectory}": ` +
            `success=${result.success}, atomic=${result.atomic}`
          );
        }
      } catch (err) {
        console.error(
          `[ChromePool] Warning: cookie sync failed for profile "${profileDirectory}":`,
          err instanceof Error ? err.message : err
        );
      }
    }

    const launchOptions: LaunchOptions = {
      port,
      autoLaunch: profileDirectory ? true : this.config.autoLaunch,
      ...(profileDirectory && { profileDirectory }),
      ...(managedUserDataDir && { userDataDir: managedUserDataDir }),
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
      lastActiveAt: Date.now(),
      ...(managedUserDataDir && { managedUserDataDir }),
    };
    if (managedUserDataDir) registerProfileUser(managedUserDataDir);

    this.instances.set(port, pooled);
    return pooled;
  }

  private async nextAvailablePort(): Promise<number> {
    // Skip ports used by our pool AND ports another process's Chrome already
    // serves (the main instance, other sessions' pools) so a new profile never
    // lands on someone else's browser.
    for (let offset = 0; offset < this.config.maxInstances + 10; offset++) {
      const candidate = this.config.basePort + offset;
      if (!this.instances.has(candidate) && !(await checkDebugPort(candidate))) {
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
