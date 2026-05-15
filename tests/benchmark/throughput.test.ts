/// <reference types="jest" />

import {
  measureThroughput,
  summarizeThroughput,
  ThroughputPass,
  DEFAULT_THROUGHPUT_CONCURRENCIES,
  DEFAULT_THROUGHPUT_WARMUP_DISCARD,
} from './throughput';
import { MCPAdapter, MCPToolResult } from './benchmark-runner';

class FakeThroughputAdapter implements MCPAdapter {
  readonly name = 'fake';
  readonly mode = 'fake';

  private tabSeq = 0;
  private readonly tabs = new Map<string, string>();
  private readonly opts: { failRate: number; latencyMs: number };

  constructor(opts: { failRate?: number; latencyMs?: number } = {}) {
    this.opts = { failRate: opts.failRate ?? 0, latencyMs: opts.latencyMs ?? 0 };
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (this.opts.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    }
    if (toolName === 'tabs_create') {
      const url = typeof args.url === 'string' ? args.url : '';
      // Stable failure pattern: every Nth URL fails. Lets tests assert the
      // success-rate column independently of the wall-clock cell.
      if (this.opts.failRate > 0 && this.tabSeq % Math.round(1 / this.opts.failRate) === 0) {
        this.tabSeq += 1;
        return { content: [{ type: 'text', text: 'forced failure' }], isError: true };
      }
      const tabId = `fake-tab-${++this.tabSeq}`;
      this.tabs.set(tabId, url);
      return { content: [{ type: 'text', text: JSON.stringify({ tabId }) }] };
    }
    if (toolName === 'read_page') {
      const tabId = typeof args.tabId === 'string' ? args.tabId : '';
      if (!this.tabs.has(tabId)) {
        return { content: [{ type: 'text', text: 'unknown tab' }], isError: true };
      }
      return { content: [{ type: 'text', text: '<html>ok</html>' }] };
    }
    if (toolName === 'tabs_close') {
      const tabId = typeof args.tabId === 'string' ? args.tabId : '';
      this.tabs.delete(tabId);
      return { content: [{ type: 'text', text: 'closed' }] };
    }
    return { content: [{ type: 'text', text: `unsupported ${toolName}` }], isError: true };
  }
}

describe('summarizeThroughput', () => {
  function pass(wallMs: number, successCount: number, failureCount = 0): ThroughputPass {
    return { wallMs, successCount, failureCount };
  }

  test('discards the warm-up prefix and reports kept count', () => {
    const passes = [pass(1000, 10), pass(500, 10), pass(400, 10), pass(420, 10)];
    const s = summarizeThroughput(2, 10, passes, 2);
    expect(s.warmupDiscarded).toBe(2);
    expect(s.sampleCount).toBe(2);
    expect(s.concurrency).toBe(2);
    expect(s.pagesPerPass).toBe(10);
  });

  test('raw pages/sec uses pagesPerPass and the mean wall time', () => {
    // 10 pages / 500 ms mean = 20 pages/s
    const passes = [pass(500, 10), pass(500, 10)];
    const s = summarizeThroughput(2, 10, passes, 0);
    expect(s.rawPagesPerSecond).toBeCloseTo(20);
  });

  test('success rate and effective throughput are reported separately from raw', () => {
    // 10 pages each pass, 5 succeed → successRate=0.5, raw=20 pg/s, effective=10 pg/s
    const passes = [pass(500, 5, 5), pass(500, 5, 5)];
    const s = summarizeThroughput(2, 10, passes, 0);
    expect(s.successRate).toBe(0.5);
    expect(s.rawPagesPerSecond).toBeCloseTo(20);
    expect(s.effectivePagesPerSecond).toBeCloseTo(10);
  });

  test('rejects non-integer or negative concurrency', () => {
    expect(() => summarizeThroughput(0, 10, [pass(100, 10)], 0)).toThrow(/concurrency/);
    expect(() => summarizeThroughput(1.5, 10, [pass(100, 10)], 0)).toThrow(/concurrency/);
  });

  test('rejects warm-up that consumes every sample', () => {
    expect(() => summarizeThroughput(1, 10, [pass(100, 10), pass(100, 10)], 2)).toThrow(/no throughput samples left/);
  });
});

describe('measureThroughput', () => {
  test('drives the adapter once per URL per pass and reports success rate', async () => {
    const adapter = new FakeThroughputAdapter({ failRate: 0 });
    const urls = ['http://x/0', 'http://x/1', 'http://x/2', 'http://x/3', 'http://x/4'];
    const summary = await measureThroughput(adapter, {
      urls,
      concurrency: 2,
      iterations: 2,
      warmupDiscard: 0,
    });
    expect(summary.sampleCount).toBe(2);
    expect(summary.pagesPerPass).toBe(5);
    expect(summary.successRate).toBe(1);
  });

  test('honors the warm-up discard contract', async () => {
    const adapter = new FakeThroughputAdapter();
    const summary = await measureThroughput(adapter, {
      urls: ['http://x/0', 'http://x/1'],
      concurrency: 1,
      iterations: DEFAULT_THROUGHPUT_WARMUP_DISCARD + 1,
      warmupDiscard: DEFAULT_THROUGHPUT_WARMUP_DISCARD,
    });
    expect(summary.warmupDiscarded).toBe(DEFAULT_THROUGHPUT_WARMUP_DISCARD);
    expect(summary.sampleCount).toBe(1);
  });

  test('rejects iterations that do not exceed the warm-up', async () => {
    const adapter = new FakeThroughputAdapter();
    await expect(
      measureThroughput(adapter, {
        urls: ['http://x/0'],
        concurrency: 1,
        iterations: 3,
        warmupDiscard: 3,
      }),
    ).rejects.toThrow(/iterations.*warmupDiscard/);
  });

  test('default concurrency cells span the issue-mandated 1/5/10/20', () => {
    expect(DEFAULT_THROUGHPUT_CONCURRENCIES).toEqual([1, 5, 10, 20]);
  });

  test('rejects empty URL sets at boundary', async () => {
    const adapter = new FakeThroughputAdapter();
    await expect(
      measureThroughput(adapter, { urls: [], concurrency: 1, iterations: 1, warmupDiscard: 0 }),
    ).rejects.toThrow(/urls/);
  });
});
