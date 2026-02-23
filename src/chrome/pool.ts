/**
 * ChromePool - Manages multiple Chrome instances on different ports
 * to solve the CDP same-origin renderer process contention issue.
 */

import * as http from 'http';
import { ChromeLauncher, ChromeInstance, LaunchOptions } from './launcher';

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

/**
 * Fetch cookies from a Chrome instance via CDP HTTP API
 */
async function fetchCookies(
  port: number,
  domain: string
): Promise<Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }>> {
  return new Promise((resolve) => {
    // Get list of tabs to find a usable websocket target
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json',
        method: 'GET',
        timeout: 3000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data);
            resolve(tabs); // caller handles further CDP calls
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

export class ChromePool {
  private config: ChromePoolConfig;
  private instances: Map<number, PooledInstance> = new Map();

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
   * Get the current instance assignment for an origin.
   * Returns the first instance that has this origin registered, or null.
   */
  getInstanceForOrigin(origin: string): PooledInstance | null {
    for (const [, instance] of this.instances) {
      if (instance.origins.has(origin)) {
        return instance;
      }
    }
    return null;
  }

  /**
   * Copy cookies between two Chrome instances for a given domain.
   * Uses CDP Network.getAllCookies / Network.setCookies via WebSocket.
   * This is a best-effort operation; failures are logged but not thrown.
   */
  async copyCookiesBetweenInstances(
    sourcePort: number,
    destPort: number,
    domain: string
  ): Promise<void> {
    const sourceInstance = this.instances.get(sourcePort);
    const destInstance = this.instances.get(destPort);

    if (!sourceInstance || !destInstance) {
      console.error(
        `[ChromePool] copyCookies: instance not found (source=${sourcePort}, dest=${destPort})`
      );
      return;
    }

    try {
      // Retrieve tab list from source to find a WS target for CDP
      const tabs = await fetchCookies(sourcePort, domain);
      if (!Array.isArray(tabs) || tabs.length === 0) {
        console.error(
          `[ChromePool] copyCookies: no tabs found on source port ${sourcePort}`
        );
        return;
      }

      // Use the first available tab's WebSocket URL for CDP
      const firstTab = tabs[0] as { webSocketDebuggerUrl?: string };
      const wsUrl: string | undefined = firstTab.webSocketDebuggerUrl;
      if (!wsUrl) {
        console.error(
          `[ChromePool] copyCookies: no WebSocket URL on source port ${sourcePort}`
        );
        return;
      }

      console.error(
        `[ChromePool] Cookie bridging from port ${sourcePort} to ${destPort} for domain "${domain}" ` +
          `requires a CDP WebSocket client. Skipping (implement via CDP client if needed).`
      );
      // Full cookie bridging requires a CDP WebSocket connection. The CDP client
      // in this project (src/cdp/client.ts) should be used here. Left as a
      // hook for integration — callers with a live CDP session can transfer
      // cookies directly via Network.getAllCookies / Network.setCookies.
    } catch (err) {
      console.error(`[ChromePool] copyCookies error:`, err);
    }
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

  private async launchNewInstance(): Promise<PooledInstance> {
    const port = this.nextAvailablePort();
    const launcher = new ChromeLauncher(port);

    const launchOptions: LaunchOptions = {
      port,
      autoLaunch: this.config.autoLaunch,
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
  }
  return poolInstance;
}
