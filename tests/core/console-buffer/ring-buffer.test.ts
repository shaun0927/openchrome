/// <reference types="jest" />
/**
 * Unit tests for ConsoleRingBuffer (#897).
 *
 * Covers:
 *  - line-cap eviction
 *  - byte-cap eviction
 *  - mixed-cap eviction (smallest cap wins)
 *  - oversized single entry → placeholder with truncatedFrom
 *  - evictedTotal monotonicity
 *  - clear() preserves evictedTotal
 *  - O(1) microbenchmark: 10^5 pushes under 50 ms
 */

import { createConsoleRingBuffer } from '../../../src/core/console-buffer/ring-buffer';

interface TestEntry {
  type: string;
  text: string;
  timestamp: number;
  truncatedFrom?: number;
}

function makeEntry(text: string, ts = Date.now()): TestEntry {
  return { type: 'log', text, timestamp: ts };
}

function makePlaceholder(originalSizeBytes: number): TestEntry {
  return {
    type: 'log',
    text: '[entry exceeded maxBytes — truncated]',
    timestamp: Date.now(),
    truncatedFrom: originalSizeBytes,
  };
}

describe('ConsoleRingBuffer', () => {
  describe('line-cap eviction', () => {
    test('push 5001 entries with maxLines:5000 — retained == 5000', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 5000, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      for (let i = 0; i < 5001; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, JSON.stringify(e).length);
      }
      const s = buf.stats();
      expect(s.retained).toBe(5000);
      expect(s.evictedTotal).toBe(1);
    });

    test('oldest entry evicted first (FIFO)', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 3, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      for (let i = 0; i < 4; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, JSON.stringify(e).length);
      }
      const entries = buf.drain();
      expect(entries[0].text).toBe('msg-1');
      expect(entries[2].text).toBe('msg-3');
    });
  });

  describe('byte-cap eviction', () => {
    test('push 10x 1 MiB entries with maxBytes:4 MiB — retained <= 4', () => {
      const oneMiB = 1024 * 1024;
      const fourMiB = 4 * oneMiB;
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 10000, maxBytes: fourMiB },
        makePlaceholder,
      );
      for (let i = 0; i < 10; i++) {
        const e = makeEntry('x'.repeat(oneMiB));
        buf.push(e, oneMiB);
      }
      const s = buf.stats();
      expect(s.retained).toBeLessThanOrEqual(4);
      expect(s.retainedBytes).toBeLessThanOrEqual(fourMiB);
    });

    test('retainedBytes stays <= maxBytes after each push', () => {
      const maxBytes = 1000;
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 10000, maxBytes },
        makePlaceholder,
      );
      for (let i = 0; i < 50; i++) {
        const e = makeEntry('a'.repeat(30)); // ~50 bytes JSON
        buf.push(e, JSON.stringify(e).length);
        expect(buf.stats().retainedBytes).toBeLessThanOrEqual(maxBytes);
      }
    });
  });

  describe('mixed-cap eviction', () => {
    test('byte cap trips before line cap', () => {
      // maxLines=100, maxBytes=200 — byte cap wins
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 100, maxBytes: 200 },
        makePlaceholder,
      );
      // Each entry ~50 bytes; after 4 pushes retainedBytes ~200
      for (let i = 0; i < 20; i++) {
        const e = makeEntry('a'.repeat(30));
        buf.push(e, 50);
      }
      const s = buf.stats();
      expect(s.retained).toBeLessThanOrEqual(4);
      expect(s.retainedBytes).toBeLessThanOrEqual(200);
      expect(s.evictedTotal).toBeGreaterThan(0);
    });

    test('line cap trips before byte cap', () => {
      // maxLines=3, maxBytes=1_000_000 — line cap wins
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 3, maxBytes: 1_000_000 },
        makePlaceholder,
      );
      for (let i = 0; i < 10; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, 20);
      }
      const s = buf.stats();
      expect(s.retained).toBe(3);
      expect(s.evictedTotal).toBe(7);
    });
  });

  describe('oversized single entry → placeholder', () => {
    test('entry whose sizeBytes > maxBytes becomes a placeholder', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 100, maxBytes: 8192 },
        makePlaceholder,
      );
      buf.push(makeEntry('x'), 10_000);
      const entries = buf.drain();
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('[entry exceeded maxBytes — truncated]');
      expect(entries[0].truncatedFrom).toBe(10_000);
    });

    test('placeholder does not count against retainedBytes cap', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 100, maxBytes: 8192 },
        makePlaceholder,
      );
      // Push an oversized entry — should store placeholder as 0 bytes
      buf.push(makeEntry('huge'), 10_000);
      const s = buf.stats();
      // Placeholder occupies 0 accounting bytes; evictedBytes stays 0
      expect(s.retainedBytes).toBe(0);
      expect(s.evictedBytes).toBe(0);
      expect(s.evictedTotal).toBe(0);
    });
  });

  describe('evictedTotal monotonicity', () => {
    test('evictedTotal never decreases across pushes', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 5, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      let lastEvicted = 0;
      for (let i = 0; i < 20; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, JSON.stringify(e).length);
        const s = buf.stats();
        expect(s.evictedTotal).toBeGreaterThanOrEqual(lastEvicted);
        lastEvicted = s.evictedTotal;
      }
    });
  });

  describe('clear() preserves evictedTotal', () => {
    test('clear resets retained but keeps evictedTotal', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 3, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      for (let i = 0; i < 5; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, JSON.stringify(e).length);
      }
      const before = buf.stats();
      expect(before.evictedTotal).toBe(2);

      buf.clear();

      const after = buf.stats();
      expect(after.retained).toBe(0);
      expect(after.retainedBytes).toBe(0);
      expect(after.evictedTotal).toBe(2); // preserved
      expect(after.firstEntryAt).toBeNull();
      expect(after.lastEntryAt).toBeNull();
    });

    test('evictedTotal continues accumulating after clear', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 2, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      // Push 3 → evicts 1
      for (let i = 0; i < 3; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, 10);
      }
      expect(buf.stats().evictedTotal).toBe(1);
      buf.clear();
      expect(buf.stats().evictedTotal).toBe(1);

      // Push 3 more → evicts 1 more
      for (let i = 0; i < 3; i++) {
        const e = makeEntry(`msg2-${i}`);
        buf.push(e, 10);
      }
      expect(buf.stats().evictedTotal).toBe(2);
    });
  });

  describe('tail()', () => {
    test('tail(n) returns newest n entries in insertion order', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 10, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      for (let i = 0; i < 5; i++) {
        const e = makeEntry(`msg-${i}`);
        buf.push(e, 10);
      }
      const t = buf.tail(3);
      expect(t).toHaveLength(3);
      expect(t[0].text).toBe('msg-2');
      expect(t[2].text).toBe('msg-4');
    });

    test('tail(n) when n > retained returns all entries', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 10, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      const e = makeEntry('only');
      buf.push(e, 10);
      expect(buf.tail(100)).toHaveLength(1);
    });

    test('tail(0) returns empty array', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 10, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      buf.push(makeEntry('x'), 5);
      expect(buf.tail(0)).toEqual([]);
    });
  });

  describe('stats() firstEntryAt / lastEntryAt', () => {
    test('firstEntryAt and lastEntryAt track correctly', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 10, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      const e1 = makeEntry('first', 1000);
      const e2 = makeEntry('last', 9999);
      buf.push(e1, 10);
      buf.push(e2, 10);
      const s = buf.stats();
      expect(s.firstEntryAt).toBe(1000);
      expect(s.lastEntryAt).toBe(9999);
    });

    test('firstEntryAt updates after eviction', () => {
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 2, maxBytes: 100_000_000 },
        makePlaceholder,
      );
      buf.push(makeEntry('a', 100), 10);
      buf.push(makeEntry('b', 200), 10);
      buf.push(makeEntry('c', 300), 10); // evicts 'a'
      expect(buf.stats().firstEntryAt).toBe(200);
    });
  });

  describe('O(1) microbenchmark', () => {
    test('10^5 pushes against a full buffer complete under 50 ms', () => {
      const N = 100_000;
      const buf = createConsoleRingBuffer<TestEntry>(
        { maxLines: 1000, maxBytes: 100_000_000 },
        makePlaceholder,
      );

      // Pre-fill to capacity so every subsequent push causes eviction
      for (let i = 0; i < 1000; i++) {
        buf.push(makeEntry(`fill-${i}`, i), 10);
      }

      const start = Date.now();
      for (let i = 0; i < N; i++) {
        buf.push(makeEntry(`push-${i}`, i), 10);
      }
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
