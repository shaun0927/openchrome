/**
 * Heap Sampler for E2E memory stability tests.
 * Takes baseline + periodic samples, asserts delta within limits.
 *
 * When a `pid` is provided, measures the target process's RSS via `ps`
 * (macOS/Linux) or `wmic` (Windows) instead of the Jest runner's heap.
 */
import { execSync } from 'child_process';
import * as os from 'os';

export interface HeapSample {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

export interface HeapSamplerOptions {
  /** PID of the process to measure. When omitted, measures the current process. */
  pid?: number;
}

export class HeapSampler {
  private baseline: HeapSample | null = null;
  private samples: HeapSample[] = [];
  private pid: number | undefined;

  constructor(opts?: HeapSamplerOptions) {
    this.pid = opts?.pid;
  }

  /**
   * Take baseline measurement.
   */
  takeBaseline(): HeapSample {
    // Force GC if available (only meaningful for in-process mode)
    if (!this.pid && global.gc) global.gc();

    this.baseline = this.snapshot();
    this.samples = [this.baseline];
    return this.baseline;
  }

  /**
   * Take a new sample.
   */
  takeSample(): HeapSample {
    const sample = this.snapshot();
    this.samples.push(sample);
    return sample;
  }

  /**
   * Get delta between baseline and latest sample.
   */
  getDelta(): { heapUsedDelta: number; rssDelta: number; heapTotalDelta: number } {
    if (!this.baseline) throw new Error('No baseline. Call takeBaseline() first.');
    const latest = this.samples[this.samples.length - 1];
    return {
      heapUsedDelta: latest.heapUsed - this.baseline.heapUsed,
      rssDelta: latest.rss - this.baseline.rss,
      heapTotalDelta: latest.heapTotal - this.baseline.heapTotal,
    };
  }

  /**
   * Assert memory is stable within limit.
   * @param maxDeltaMB Maximum allowed heap delta in megabytes.
   * @throws If delta exceeds limit.
   */
  assertStable(maxDeltaMB: number): void {
    // Take a final sample with GC (GC only meaningful for in-process mode)
    if (!this.pid && global.gc) global.gc();
    this.takeSample();

    const delta = this.getDelta();
    const deltaHeapMB = delta.heapUsedDelta / (1024 * 1024);
    const deltaRssMB = delta.rssDelta / (1024 * 1024);

    if (deltaHeapMB > maxDeltaMB) {
      throw new Error(
        `Memory unstable: heap grew ${deltaHeapMB.toFixed(1)}MB (limit: ${maxDeltaMB}MB). ` +
        `RSS delta: ${deltaRssMB.toFixed(1)}MB. ` +
        `Samples: ${this.samples.length}`
      );
    }

    console.error(
      `[heap-sampler] Stable: heap delta=${deltaHeapMB.toFixed(1)}MB, ` +
      `RSS delta=${deltaRssMB.toFixed(1)}MB (limit: ${maxDeltaMB}MB, samples: ${this.samples.length})`
    );
  }

  /**
   * Get all samples for analysis.
   */
  getSamples(): HeapSample[] {
    return [...this.samples];
  }

  /**
   * Get trend: average heap growth per sample.
   */
  getTrend(): { avgGrowthPerSampleMB: number; totalSamples: number } {
    if (this.samples.length < 2) return { avgGrowthPerSampleMB: 0, totalSamples: this.samples.length };

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const totalGrowth = (last.heapUsed - first.heapUsed) / (1024 * 1024);

    return {
      avgGrowthPerSampleMB: totalGrowth / (this.samples.length - 1),
      totalSamples: this.samples.length,
    };
  }

  private snapshot(): HeapSample {
    if (this.pid !== undefined) {
      return this.snapshotExternalPid(this.pid);
    }
    const mem = process.memoryUsage();
    return {
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
    };
  }

  /**
   * Snapshot memory for an external process by PID.
   * Uses `ps -o rss=` on macOS/Linux, `wmic` on Windows.
   * RSS is reported in KB by ps; we convert to bytes.
   * Since we cannot access a remote V8 heap, RSS is used for all heap metrics.
   * Returns null-equivalent sample (zeros) if the process has exited.
   */
  private snapshotExternalPid(pid: number): HeapSample {
    try {
      let rssBytes: number;

      if (os.platform() === 'win32') {
        // wmic returns WorkingSetSize in bytes
        const out = execSync(`wmic process where ProcessId=${pid} get WorkingSetSize /value`, {
          timeout: 5000,
          encoding: 'utf8',
        });
        const match = out.match(/WorkingSetSize=(\d+)/);
        if (!match) {
          // Process not found — skip sample by returning last known or zero
          return this.lastSampleOrZero();
        }
        rssBytes = parseInt(match[1], 10);
      } else {
        // macOS / Linux: ps -o rss= -p <pid> returns KB
        const out = execSync(`ps -o rss= -p ${pid}`, {
          timeout: 5000,
          encoding: 'utf8',
        });
        const trimmed = out.trim();
        if (!trimmed) {
          return this.lastSampleOrZero();
        }
        rssBytes = parseInt(trimmed, 10) * 1024;
      }

      // Use RSS as the primary metric for all heap fields since we cannot
      // introspect another process's V8 heap.
      return {
        timestamp: Date.now(),
        heapUsed: rssBytes,
        heapTotal: rssBytes,
        rss: rssBytes,
        external: 0,
      };
    } catch {
      // Process may have exited — skip this sample silently
      console.error(`[heap-sampler] Could not read memory for pid ${pid}, process may have exited`);
      return this.lastSampleOrZero();
    }
  }

  /**
   * Return the last recorded sample, or a zero-filled sample if none exists yet.
   * Used when the target process is unreachable so we don't inflate deltas.
   */
  private lastSampleOrZero(): HeapSample {
    if (this.samples.length > 0) {
      return { ...this.samples[this.samples.length - 1], timestamp: Date.now() };
    }
    return { timestamp: Date.now(), heapUsed: 0, heapTotal: 0, rss: 0, external: 0 };
  }
}
