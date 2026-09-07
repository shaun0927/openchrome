/**
 * Heap Sampler for E2E memory stability tests.
 * Takes baseline + periodic samples, asserts delta within limits.
 *
 * An external pid measures process RSS (Unix) or working set (Windows),
 * not its V8 heap and not the Chrome process tree. Missing samples invalidate
 * the window; legacy heap fields contain resident bytes in external mode.
 */
import { readProcessMemorySync } from '../../../src/core/process/memory';

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
  private identity: string | undefined;
  private collectionFailure: Error | undefined;

  constructor(opts?: HeapSamplerOptions) {
    this.pid = opts?.pid;
  }

  /**
   * Take baseline measurement.
   */
  takeBaseline(): HeapSample {
    this.identity = undefined;
    this.collectionFailure = undefined;
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
    if (!Number.isFinite(maxDeltaMB) || maxDeltaMB < 0) throw new Error('Invalid memory growth limit');
    if (this.collectionFailure) throw this.collectionFailure;
    // Take a final sample with GC (GC only meaningful for in-process mode)
    if (!this.pid && global.gc) global.gc();
    this.takeSample();

    if (!this.baseline || this.samples.length < 2) throw new Error('Memory stability requires a baseline and a valid follow-up sample');

    const delta = this.getDelta();
    const deltaHeapMB = (Math.max(...this.samples.map(sample => sample.heapUsed)) - this.baseline.heapUsed) / (1024 * 1024);
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
   * Reads resident memory, not the external process's V8 heap. Legacy heap
   * fields retain resident bytes for compatibility. Collection failure or
   * process identity change invalidates this entire measurement window.
   */
  private snapshotExternalPid(pid: number): HeapSample {
    try {
      const sample = readProcessMemorySync(pid);
      if (this.identity !== undefined && this.identity !== sample.identity) throw new Error('Measured process identity changed');
      this.identity = sample.identity;
      const rssBytes = sample.residentBytes;

      // Use RSS as the primary metric for all heap fields since we cannot
      // introspect another process's V8 heap.
      return {
        timestamp: Date.now(),
        heapUsed: rssBytes,
        heapTotal: rssBytes,
        rss: rssBytes,
        external: 0,
      };
    } catch (error) {
      this.collectionFailure = new Error(`Memory stability inconclusive for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      throw this.collectionFailure;
    }
  }
}
