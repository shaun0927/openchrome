/// <reference types="jest" />

import { MCPAdapter, MCPToolResult } from './benchmark-runner';
import {
  summarizeLatencies,
  measureLatency,
  DEFAULT_WARMUP_DISCARD,
} from './latency';

describe('summarizeLatencies', () => {
  test('discards the warm-up prefix before computing the distribution', () => {
    // First 3 samples are inflated warm-up; only [10,10,10,10] should count.
    const summary = summarizeLatencies('warm', [999, 999, 999, 10, 10, 10, 10], 3);
    expect(summary.warmupDiscarded).toBe(3);
    expect(summary.sampleCount).toBe(4);
    expect(summary.meanMs).toBe(10);
    expect(summary.maxMs).toBe(10);
    expect(summary.samples).toEqual([10, 10, 10, 10]);
  });

  test('computes p50 and p95 from kept samples', () => {
    const raw = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const summary = summarizeLatencies('cold', raw, 0);
    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(95);
    expect(summary.minMs).toBe(1);
    expect(summary.maxMs).toBe(100);
  });

  test('bootstrap CI brackets the mean', () => {
    const summary = summarizeLatencies('warm', [8, 9, 10, 11, 12, 13], 0);
    const [lo, hi] = summary.ci95Ms;
    expect(lo).toBeLessThanOrEqual(summary.meanMs);
    expect(hi).toBeGreaterThanOrEqual(summary.meanMs);
  });

  test('throws when warm-up discard leaves no samples', () => {
    expect(() => summarizeLatencies('cold', [1, 2, 3], 3)).toThrow(/no latency samples left/);
  });

  test('rejects a negative or non-integer warm-up discard', () => {
    expect(() => summarizeLatencies('cold', [1, 2, 3], -1)).toThrow(/non-negative integer/);
    expect(() => summarizeLatencies('cold', [1, 2, 3], 1.5)).toThrow(/non-negative integer/);
  });
});

/**
 * Records the tool-call sequence so the test can assert cold vs warm drive
 * the adapter differently.
 */
function makeRecordingAdapter(): { adapter: MCPAdapter; calls: string[] } {
  const calls: string[] = [];
  let tabSeq = 0;
  const adapter: MCPAdapter = {
    name: 'recording-stub',
    mode: 'dom',
    async callTool(tool: string): Promise<MCPToolResult> {
      calls.push(tool);
      if (tool === 'tabs_create') {
        return { content: [{ type: 'text', text: JSON.stringify({ tabId: `tab-${++tabSeq}` }) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  return { adapter, calls };
}

describe('measureLatency', () => {
  test('warm mode creates one tab and re-reads it each iteration', async () => {
    const { adapter, calls } = makeRecordingAdapter();
    const summary = await measureLatency(adapter, {
      mode: 'warm',
      url: 'http://127.0.0.1/small',
      iterations: 5,
      warmupDiscard: 2,
    });
    expect(calls.filter((c) => c === 'tabs_create')).toHaveLength(1);
    expect(calls.filter((c) => c === 'read_page')).toHaveLength(5);
    expect(calls.filter((c) => c === 'tabs_close')).toHaveLength(1);
    expect(summary.sampleCount).toBe(3); // 5 iterations - 2 warm-up
    expect(summary.mode).toBe('warm');
  });

  test('cold mode creates a fresh tab for every iteration', async () => {
    const { adapter, calls } = makeRecordingAdapter();
    const summary = await measureLatency(adapter, {
      mode: 'cold',
      url: 'http://127.0.0.1/small',
      iterations: 4,
      warmupDiscard: 1,
    });
    expect(calls.filter((c) => c === 'tabs_create')).toHaveLength(4);
    expect(calls.filter((c) => c === 'read_page')).toHaveLength(4);
    expect(calls.filter((c) => c === 'tabs_close')).toHaveLength(4);
    expect(summary.sampleCount).toBe(3); // 4 iterations - 1 warm-up
  });

  test('defaults to DEFAULT_WARMUP_DISCARD when not specified', async () => {
    const { adapter } = makeRecordingAdapter();
    const summary = await measureLatency(adapter, {
      mode: 'warm',
      url: 'http://127.0.0.1/small',
      iterations: DEFAULT_WARMUP_DISCARD + 2,
    });
    expect(summary.warmupDiscarded).toBe(DEFAULT_WARMUP_DISCARD);
    expect(summary.sampleCount).toBe(2);
  });

  test('rejects iterations that do not exceed the warm-up discard', async () => {
    const { adapter } = makeRecordingAdapter();
    await expect(
      measureLatency(adapter, { mode: 'cold', url: 'http://x/small', iterations: 3, warmupDiscard: 3 }),
    ).rejects.toThrow(/must be an integer greater than warmupDiscard/);
  });

  test('throws when tabs_create yields no tabId', async () => {
    const adapter: MCPAdapter = {
      name: 'bad-stub',
      mode: 'dom',
      async callTool(): Promise<MCPToolResult> {
        return { content: [{ type: 'text', text: 'no tab here' }] };
      },
    };
    await expect(
      measureLatency(adapter, { mode: 'warm', url: 'http://x/small', iterations: 5 }),
    ).rejects.toThrow(/could not resolve tabId/);
  });
});
