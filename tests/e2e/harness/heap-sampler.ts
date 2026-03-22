/**
 * Heap Sampler for E2E memory stability tests.
 * Takes baseline + periodic samples, asserts delta within limits.
 */

export interface HeapSample {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
}

export class HeapSampler {
  private baseline: HeapSample | null = null;
  private samples: HeapSample[] = [];

  /**
   * Take baseline measurement.
   */
  takeBaseline(): HeapSample {
    // Force GC if available
    if (global.gc) global.gc();

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
    // Take a final sample with GC
    if (global.gc) global.gc();
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
    const mem = process.memoryUsage();
    return {
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
    };
  }
}
