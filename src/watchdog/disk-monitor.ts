/**
 * Disk Monitor — monitors ~/.openchrome/ size and auto-prunes old files.
 * Part of the Reliability Guarantee Initiative, Phase 7.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface DiskMonitorOptions {
  /** Check interval in ms. Default: 300000 (5 minutes) */
  checkIntervalMs?: number;
  /** Warning threshold in bytes. Default: 500MB */
  warnThresholdBytes?: number;
  /** Aggressive cleanup threshold in bytes. Default: 1GB */
  cleanupThresholdBytes?: number;
  /** Journal retention in days. Default: 7 */
  journalRetentionDays?: number;
  /** Snapshot retention in days. Default: 30 */
  snapshotRetentionDays?: number;
  /** Max checkpoint count. Default: 10 */
  maxCheckpoints?: number;
}

export interface DiskUsageStats {
  totalBytes: number;
  journalBytes: number;
  snapshotBytes: number;
  checkpointBytes: number;
  memoryBytes: number;
  otherBytes: number;
  fileCount: number;
}

export class DiskMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly baseDir: string;
  private readonly options: Required<DiskMonitorOptions>;
  private lastStats: DiskUsageStats | null = null;
  private pruneInProgress = false;

  constructor(options?: DiskMonitorOptions) {
    this.baseDir = path.join(os.homedir(), '.openchrome');
    this.options = {
      checkIntervalMs: options?.checkIntervalMs ?? 300000,
      warnThresholdBytes: options?.warnThresholdBytes ?? 500 * 1024 * 1024,
      cleanupThresholdBytes: options?.cleanupThresholdBytes ?? 1024 * 1024 * 1024,
      journalRetentionDays: options?.journalRetentionDays ?? 7,
      snapshotRetentionDays: options?.snapshotRetentionDays ?? 30,
      maxCheckpoints: options?.maxCheckpoints ?? 10,
    };
  }

  /**
   * Start periodic monitoring.
   */
  start(): void {
    this.stop();
    // Run immediately, then on interval
    this.check().catch(err => {
      console.error('[DiskMonitor] Initial check failed:', err);
    });
    this.timer = setInterval(() => {
      this.check().catch(err => {
        console.error('[DiskMonitor] Periodic check failed:', err);
      });
    }, this.options.checkIntervalMs);
    this.timer.unref(); // Don't prevent process exit
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Get latest disk usage stats.
   */
  getStats(): DiskUsageStats | null {
    return this.lastStats;
  }

  /**
   * Run a check: measure size, warn if needed, prune if threshold exceeded.
   */
  async check(): Promise<DiskUsageStats> {
    const stats = await this.measureUsage();
    this.lastStats = stats;

    if (stats.totalBytes >= this.options.cleanupThresholdBytes) {
      console.error(`[DiskMonitor] Disk usage ${formatBytes(stats.totalBytes)} exceeds cleanup threshold ${formatBytes(this.options.cleanupThresholdBytes)}, pruning...`);
      await this.prune();
      // Re-measure after pruning
      const after = await this.measureUsage();
      this.lastStats = after;
      console.error(`[DiskMonitor] After pruning: ${formatBytes(after.totalBytes)} (${after.fileCount} files)`);
    } else if (stats.totalBytes >= this.options.warnThresholdBytes) {
      console.error(`[DiskMonitor] Warning: disk usage ${formatBytes(stats.totalBytes)} approaching threshold`);
    }

    return this.lastStats;
  }

  /**
   * Measure disk usage by subdirectory.
   */
  private async measureUsage(): Promise<DiskUsageStats> {
    const stats: DiskUsageStats = {
      totalBytes: 0,
      journalBytes: 0,
      snapshotBytes: 0,
      checkpointBytes: 0,
      memoryBytes: 0,
      otherBytes: 0,
      fileCount: 0,
    };

    try {
      await this.walkDir(this.baseDir, stats);
    } catch {
      // Directory may not exist yet
    }

    return stats;
  }

  private async walkDir(dir: string, stats: DiskUsageStats): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Directory doesn't exist or not readable
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(fullPath, stats);
      } else if (entry.isFile()) {
        try {
          const fileStat = await fs.stat(fullPath);
          const size = fileStat.size;
          stats.totalBytes += size;
          stats.fileCount += 1;

          // Categorize by subdirectory
          const relPath = path.relative(this.baseDir, fullPath);
          if (relPath.startsWith('journal')) {
            stats.journalBytes += size;
          } else if (relPath.startsWith('snapshots')) {
            stats.snapshotBytes += size;
          } else if (relPath.startsWith('checkpoints')) {
            stats.checkpointBytes += size;
          } else if (relPath.startsWith('memory')) {
            stats.memoryBytes += size;
          } else {
            stats.otherBytes += size;
          }
        } catch {
          // File may have been deleted between readdir and stat
        }
      }
    }
  }

  /**
   * Prune old files based on retention policies.
   */
  async prune(): Promise<{ journalsPruned: number; snapshotsPruned: number; checkpointsPruned: number }> {
    if (this.pruneInProgress) return { journalsPruned: 0, snapshotsPruned: 0, checkpointsPruned: 0 };
    this.pruneInProgress = true;

    let journalsPruned = 0;
    let snapshotsPruned = 0;
    let checkpointsPruned = 0;

    try {
      journalsPruned = await this.pruneByAge(
        path.join(this.baseDir, 'journal'),
        this.options.journalRetentionDays
      );

      snapshotsPruned = await this.pruneByAge(
        path.join(this.baseDir, 'snapshots'),
        this.options.snapshotRetentionDays
      );

      checkpointsPruned = await this.pruneByCount(
        path.join(this.baseDir, 'checkpoints'),
        this.options.maxCheckpoints
      );

      if (journalsPruned + snapshotsPruned + checkpointsPruned > 0) {
        console.error(`[DiskMonitor] Pruned: ${journalsPruned} journals, ${snapshotsPruned} snapshots, ${checkpointsPruned} checkpoints`);
      }
    } catch (err) {
      console.error('[DiskMonitor] Prune error:', err);
    } finally {
      this.pruneInProgress = false;
    }

    return { journalsPruned, snapshotsPruned, checkpointsPruned };
  }

  /**
   * Delete files older than retentionDays in the given directory.
   */
  private async pruneByAge(dir: string, retentionDays: number): Promise<number> {
    let pruned = 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(fullPath);
            pruned++;
          }
        } else if (entry.isDirectory()) {
          // Recurse into subdirectories (journals use daily dirs)
          const subPruned = await this.pruneByAge(fullPath, retentionDays);
          pruned += subPruned;
          // Remove empty directories
          try {
            const remaining = await fs.readdir(fullPath);
            if (remaining.length === 0) {
              await fs.rmdir(fullPath);
            }
          } catch {
            // Best effort
          }
        }
      } catch {
        // File may have been deleted concurrently
      }
    }

    return pruned;
  }

  /**
   * Keep only the most recent maxCount files in the given directory.
   */
  private async pruneByCount(dir: string, maxCount: number): Promise<number> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }

    // Get file stats and sort by mtime (newest first)
    const files: { path: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          // Skip files that disappeared
        }
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    let pruned = 0;
    for (let i = maxCount; i < files.length; i++) {
      try {
        await fs.unlink(files[i].path);
        pruned++;
      } catch {
        // Best effort
      }
    }

    return pruned;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
