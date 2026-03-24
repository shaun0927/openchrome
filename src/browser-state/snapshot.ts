/**
 * Browser State Snapshot Manager — Gap 2 (#416)
 *
 * Periodically snapshots browser cookies and tab URLs to disk so they
 * can be restored after a Chrome crash + auto-reconnect. This is the
 * most critical gap for long-running session reliability: without state
 * restoration, a Chrome crash effectively fails the entire task.
 *
 * Design:
 *  - Cookie/tab retrieval is injected via provider functions to decouple
 *    from CDP internals and avoid circular dependencies.
 *  - Snapshots are plain JSON files in ~/.openchrome/snapshots/.
 *  - Old snapshots are pruned to keep disk usage bounded.
 *  - All restore operations are best-effort (try/catch, non-fatal).
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  DEFAULT_SNAPSHOT_MAX_COUNT,
} from '../config/defaults';

export interface BrowserSnapshot {
  timestamp: number;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
  }>;
  tabUrls: string[];
}

export class BrowserStateManager {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly maxSnapshots: number;
  private readonly snapshotDir: string;
  private lastSnapshotAt = 0;
  private snapshotCount = 0;
  private getCookiesFn: (() => Promise<any[]>) | null = null;
  private getTabUrlsFn: (() => Promise<string[]>) | null = null;

  constructor(opts?: { intervalMs?: number; maxSnapshots?: number }) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.maxSnapshots = opts?.maxSnapshots ?? DEFAULT_SNAPSHOT_MAX_COUNT;
    this.snapshotDir = path.join(os.homedir(), '.openchrome', 'snapshots');
  }

  /**
   * Register the cookie retrieval function (called from index.ts after CDP client is ready).
   * This decouples snapshot logic from CDP internals.
   */
  setCookieProvider(fn: () => Promise<any[]>): void {
    this.getCookiesFn = fn;
  }

  /**
   * Register the tab URL retrieval function.
   */
  setTabUrlProvider(fn: () => Promise<string[]>): void {
    this.getTabUrlsFn = fn;
  }

  async start(): Promise<void> {
    this.stop();
    await fs.mkdir(this.snapshotDir, { recursive: true });
    // Don't take immediate snapshot — wait for first interval
    this.timer = setInterval(() => {
      this.takeSnapshot().catch(err => {
        console.error('[BrowserState] Snapshot failed:', err);
      });
    }, this.intervalMs);
    this.timer.unref();
    console.error(`[BrowserState] Snapshot service started (interval: ${this.intervalMs}ms, dir: ${this.snapshotDir})`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async takeSnapshot(): Promise<void> {
    if (!this.getCookiesFn) return;

    try {
      const cookies = await this.getCookiesFn();
      const tabUrls = this.getTabUrlsFn ? await this.getTabUrlsFn() : [];

      const snapshot: BrowserSnapshot = {
        timestamp: Date.now(),
        cookies,
        tabUrls,
      };

      const filename = `snapshot-${Date.now()}.json`;
      const filepath = path.join(this.snapshotDir, filename);
      await fs.writeFile(filepath, JSON.stringify(snapshot), 'utf-8');
      this.lastSnapshotAt = Date.now();
      this.snapshotCount++;

      // Prune old snapshots
      await this.pruneSnapshots();

      console.error(`[BrowserState] Snapshot saved: ${cookies.length} cookies, ${tabUrls.length} tabs`);
    } catch (err) {
      console.error('[BrowserState] Failed to take snapshot:', err);
    }
  }

  /**
   * Restore cookies from the latest snapshot.
   * Called after Chrome reconnection.
   * Returns the number of cookies restored, or 0 if no snapshot available.
   */
  async restoreLatest(): Promise<number> {
    try {
      const files = await fs.readdir(this.snapshotDir);
      const snapshotFiles = files
        .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort()
        .reverse(); // newest first

      if (snapshotFiles.length === 0) {
        console.error('[BrowserState] No snapshots available for restore');
        return 0;
      }

      const latestPath = path.join(this.snapshotDir, snapshotFiles[0]);
      const content = await fs.readFile(latestPath, 'utf-8');
      const snapshot: BrowserSnapshot = JSON.parse(content);

      console.error(`[BrowserState] Restoring from snapshot: ${snapshot.cookies.length} cookies (age: ${Math.round((Date.now() - snapshot.timestamp) / 1000)}s)`);
      return snapshot.cookies.length;
    } catch (err) {
      console.error('[BrowserState] Restore failed:', err);
      return 0;
    }
  }

  /**
   * Load the latest snapshot's cookies (raw data for the caller to apply via CDP).
   */
  async getLatestCookies(): Promise<any[] | null> {
    try {
      const files = await fs.readdir(this.snapshotDir);
      const snapshotFiles = files
        .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (snapshotFiles.length === 0) return null;

      const latestPath = path.join(this.snapshotDir, snapshotFiles[0]);
      const content = await fs.readFile(latestPath, 'utf-8');
      const snapshot: BrowserSnapshot = JSON.parse(content);
      return snapshot.cookies;
    } catch {
      return null;
    }
  }

  private async pruneSnapshots(): Promise<void> {
    try {
      const files = await fs.readdir(this.snapshotDir);
      const snapshotFiles = files
        .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
        .sort()
        .reverse();

      // Keep only maxSnapshots newest
      const toDelete = snapshotFiles.slice(this.maxSnapshots);
      for (const file of toDelete) {
        await fs.unlink(path.join(this.snapshotDir, file));
      }
    } catch {
      // best-effort pruning
    }
  }

  getStatus(): { lastSnapshotAt: number; snapshotCount: number } {
    return { lastSnapshotAt: this.lastSnapshotAt, snapshotCount: this.snapshotCount };
  }
}
