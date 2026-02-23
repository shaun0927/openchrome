/// <reference types="jest" />

import { measureCall, extractServerTiming, createCounters, MeasureCounters } from './utils';

describe('measureCall', () => {
  test('accumulates inputChars and outputChars', () => {
    const counters = createCounters();
    const args = { url: 'https://example.com', tabId: 'tab1' };
    const result = { content: [{ type: 'text', text: 'response' }] };

    measureCall(result, args, counters);

    expect(counters.inputChars).toBe(JSON.stringify(args).length);
    expect(counters.outputChars).toBe(JSON.stringify(result).length);
    expect(counters.toolCallCount).toBe(1);
  });

  test('accumulates across multiple calls', () => {
    const counters = createCounters();
    const args1 = { url: 'a' };
    const args2 = { url: 'bb' };
    const result = { content: [{ type: 'text', text: 'ok' }] };

    measureCall(result, args1, counters);
    measureCall(result, args2, counters);

    expect(counters.toolCallCount).toBe(2);
    expect(counters.inputChars).toBe(
      JSON.stringify(args1).length + JSON.stringify(args2).length
    );
  });

  test('extracts _timing.durationMs from top-level', () => {
    const counters = createCounters();
    const args = { tabId: 'tab1' };
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      _timing: { durationMs: 42, startTime: 1000, endTime: 1042 },
    };

    measureCall(result, args, counters);

    expect(counters.serverTimingMs).toBe(42);
  });

  test('handles missing _timing gracefully', () => {
    const counters = createCounters();
    const args = { tabId: 'tab1' };
    const result = { content: [{ type: 'text', text: 'ok' }] };

    measureCall(result, args, counters);

    expect(counters.serverTimingMs).toBe(0);
  });

  test('works with legacy counters (no serverTimingMs field)', () => {
    const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };
    const args = { tabId: 'tab1' };
    const result = {
      content: [{ type: 'text', text: 'ok' }],
      _timing: { durationMs: 100 },
    };

    // Should not crash even though counters lacks serverTimingMs
    measureCall(result, args, counters);

    expect(counters.toolCallCount).toBe(1);
    expect((counters as MeasureCounters).serverTimingMs).toBeUndefined();
  });
});

describe('extractServerTiming', () => {
  test('extracts from top-level _timing', () => {
    const result = { _timing: { durationMs: 55 } };
    expect(extractServerTiming(result)).toBe(55);
  });

  test('extracts from content text JSON with _timing', () => {
    const inner = JSON.stringify({ data: 'test', _timing: { durationMs: 33 } });
    const result = { content: [{ type: 'text', text: inner }] };
    expect(extractServerTiming(result)).toBe(33);
  });

  test('returns 0 for null', () => {
    expect(extractServerTiming(null)).toBe(0);
  });

  test('returns 0 for undefined', () => {
    expect(extractServerTiming(undefined)).toBe(0);
  });

  test('returns 0 for non-object', () => {
    expect(extractServerTiming('string')).toBe(0);
    expect(extractServerTiming(42)).toBe(0);
  });

  test('returns 0 for invalid _timing structure', () => {
    expect(extractServerTiming({ _timing: 'not an object' })).toBe(0);
    expect(extractServerTiming({ _timing: { durationMs: 'not a number' } })).toBe(0);
  });

  test('returns 0 for content with non-JSON text', () => {
    const result = { content: [{ type: 'text', text: 'not json' }] };
    expect(extractServerTiming(result)).toBe(0);
  });
});

describe('createCounters', () => {
  test('returns zero-initialized counters', () => {
    const counters = createCounters();
    expect(counters).toEqual({
      inputChars: 0,
      outputChars: 0,
      toolCallCount: 0,
      serverTimingMs: 0,
    });
  });
});
