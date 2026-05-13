/**
 * Unit tests for the mutation-aware snapshot cache (#879 / PR #929).
 *
 * The cache is intentionally pure JS — no Chrome / CDP imports — so these
 * tests run against the real class without any harness. They cover the five
 * invariants documented in `src/core/perception/snapshot-cache.ts`:
 *
 *   1. Byte-equal hits via key match.
 *   2. Mutation bumps docEpoch ⇒ later reads miss.
 *   3. Cache is per-target; `destroy()` wipes everything.
 *   4. LRU cap = 32 (configurable) and 30s TTL (configurable).
 *   5. Any uncertainty (stale epoch, ttl expiry) returns a forced miss.
 *
 * The test suite does NOT pull in the host-side CDP wiring; that lives in
 * `src/utils/snapshot-cache-helper.ts` and is verified by integration tests.
 */

import {
  SnapshotCache,
  type SnapshotCacheKey,
  type SnapshotKind,
} from '../../../src/core/perception/snapshot-cache';
import { getCacheForPage } from '../../../src/utils/snapshot-cache-helper';

function makeKey(
  cache: SnapshotCache,
  kind: SnapshotKind,
  frameId: string,
  paramsHash = 'h-default',
  viewport = { w: 1280, h: 720, dpr: 1 },
): SnapshotCacheKey {
  return cache.buildKey({ kind, frameId, paramsHash, viewportRect: viewport });
}

describe('SnapshotCache — basic get/set', () => {
  test('miss on empty cache', () => {
    const cache = new SnapshotCache();
    expect(cache.get(makeKey(cache, 'read_page.ax', 'F1'))).toBeNull();
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().misses).toBe(1);
  });

  test('set then get returns the same value with certain:true', () => {
    const cache = new SnapshotCache();
    const key = makeKey(cache, 'read_page.ax', 'F1');
    cache.set(key, { ax: 'tree' });
    const hit = cache.get<{ ax: string }>(key);
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual({ ax: 'tree' });
    expect(hit!.certain).toBe(true);
    expect(typeof hit!.age_ms).toBe('number');
    expect(cache.stats().hits).toBe(1);
  });

  test('different paramsHash → independent slots', () => {
    const cache = new SnapshotCache();
    const a = makeKey(cache, 'find', 'F1', 'param-a');
    const b = makeKey(cache, 'find', 'F1', 'param-b');
    cache.set(a, 'A');
    cache.set(b, 'B');
    expect(cache.get<string>(a)!.value).toBe('A');
    expect(cache.get<string>(b)!.value).toBe('B');
  });

  test('different viewport → independent slots', () => {
    const cache = new SnapshotCache();
    const desktop = makeKey(cache, 'read_page.dom', 'F1', 'h', { w: 1280, h: 720, dpr: 1 });
    const mobile = makeKey(cache, 'read_page.dom', 'F1', 'h', { w: 375, h: 667, dpr: 2 });
    cache.set(desktop, 'D');
    cache.set(mobile, 'M');
    expect(cache.get<string>(desktop)!.value).toBe('D');
    expect(cache.get<string>(mobile)!.value).toBe('M');
  });
});

describe('SnapshotCache — invariant: mutation invalidates', () => {
  test('markFrameDirty bumps epoch ⇒ subsequent get misses', () => {
    const cache = new SnapshotCache();
    const before = cache.getDocEpoch('F1');
    const key = makeKey(cache, 'read_page.ax', 'F1');
    cache.set(key, 'v1');
    expect(cache.get<string>(key)!.value).toBe('v1');

    cache.markFrameDirty('F1');
    expect(cache.getDocEpoch('F1')).toBe(before + 1);
    // Same key (stale epoch) → miss, not a stale hit.
    expect(cache.get(key)).toBeNull();
  });

  test('evictFrame is a markFrameDirty alias (any reason)', () => {
    const cache = new SnapshotCache();
    const key = makeKey(cache, 'find', 'F1');
    cache.set(key, 'x');
    cache.evictFrame('F1', 'document_updated');
    expect(cache.get(key)).toBeNull();
    cache.set(makeKey(cache, 'find', 'F1'), 'y');
    cache.evictFrame('F1', 'frame_navigated');
    expect(cache.size()).toBe(0);
  });

  test('mutating frame F1 does NOT invalidate F2 entries', () => {
    const cache = new SnapshotCache();
    const a = makeKey(cache, 'read_page.ax', 'F1');
    const b = makeKey(cache, 'read_page.ax', 'F2');
    cache.set(a, 'A');
    cache.set(b, 'B');
    cache.markFrameDirty('F1');
    expect(cache.get(a)).toBeNull();
    expect(cache.get<string>(b)!.value).toBe('B');
  });

  test('lost race: set with stale epoch is silently dropped', () => {
    const cache = new SnapshotCache();
    // Caller builds key BEFORE the mutation.
    const staleKey = makeKey(cache, 'find', 'F1');
    cache.markFrameDirty('F1');
    cache.set(staleKey, 'lost-value');
    // The cache should not have recorded the stale value.
    expect(cache.size()).toBe(0);
    expect(cache.get(staleKey)).toBeNull();
  });
});

describe('SnapshotCache — invariant: LRU cap', () => {
  test('default cap = 32: 33rd entry evicts the LRU', () => {
    const cache = new SnapshotCache();
    for (let i = 0; i < 32; i++) {
      cache.set(makeKey(cache, 'find', 'F1', `h-${i}`), `v-${i}`);
    }
    expect(cache.size()).toBe(32);
    // The first inserted entry is the LRU; insert one more.
    cache.set(makeKey(cache, 'find', 'F1', 'h-33'), 'v-33');
    expect(cache.size()).toBe(32);
    expect(cache.get(makeKey(cache, 'find', 'F1', 'h-0'))).toBeNull();
    expect(cache.get<string>(makeKey(cache, 'find', 'F1', 'h-33'))!.value).toBe('v-33');
    expect(cache.stats().evictions).toBeGreaterThanOrEqual(1);
  });

  test('a get() refresh moves an entry to MRU; LRU eviction skips it', () => {
    const cache = new SnapshotCache({ maxEntries: 3 });
    const k0 = makeKey(cache, 'find', 'F1', 'h-0');
    const k1 = makeKey(cache, 'find', 'F1', 'h-1');
    const k2 = makeKey(cache, 'find', 'F1', 'h-2');
    cache.set(k0, 'v0');
    cache.set(k1, 'v1');
    cache.set(k2, 'v2');
    // Touch k0 — moves to MRU.
    cache.get(k0);
    // Insert a 4th; eviction target should be k1 (now the LRU), not k0.
    cache.set(makeKey(cache, 'find', 'F1', 'h-3'), 'v3');
    expect(cache.get<string>(k0)!.value).toBe('v0');
    expect(cache.get(k1)).toBeNull();
  });

  test('cap is configurable', () => {
    const cache = new SnapshotCache({ maxEntries: 2 });
    cache.set(makeKey(cache, 'find', 'F1', 'a'), 'A');
    cache.set(makeKey(cache, 'find', 'F1', 'b'), 'B');
    cache.set(makeKey(cache, 'find', 'F1', 'c'), 'C');
    expect(cache.size()).toBe(2);
  });
});

describe('SnapshotCache — invariant: TTL', () => {
  test('default TTL 30s; entries beyond ttl miss', () => {
    let now = 1_000_000;
    const cache = new SnapshotCache({ ttlMs: 30_000, now: () => now });
    const key = makeKey(cache, 'read_page.ax', 'F1');
    cache.set(key, 'x');
    now += 29_999;
    expect(cache.get<string>(key)!.value).toBe('x');
    now += 2; // crosses the threshold
    expect(cache.get(key)).toBeNull();
    expect(cache.stats().evictions).toBeGreaterThanOrEqual(1);
  });

  test('TTL is configurable', () => {
    let now = 0;
    const cache = new SnapshotCache({ ttlMs: 100, now: () => now });
    const key = makeKey(cache, 'find', 'F1');
    cache.set(key, 'y');
    now = 50;
    expect(cache.get<string>(key)!.value).toBe('y');
    now = 250;
    expect(cache.get(key)).toBeNull();
  });

  test('ttlMs = 0 disables expiry (entries live until LRU evicts)', () => {
    let now = 0;
    const cache = new SnapshotCache({ ttlMs: 0, now: () => now });
    const key = makeKey(cache, 'find', 'F1');
    cache.set(key, 'forever');
    now = 1_000_000_000;
    expect(cache.get<string>(key)!.value).toBe('forever');
  });
});

describe('SnapshotCache — destroy + stats', () => {
  test('destroy clears entries AND docEpochs', () => {
    const cache = new SnapshotCache();
    cache.set(makeKey(cache, 'find', 'F1'), 'x');
    cache.markFrameDirty('F1');
    expect(cache.getDocEpoch('F1')).toBe(1);
    cache.destroy();
    expect(cache.size()).toBe(0);
    expect(cache.getDocEpoch('F1')).toBe(0);
  });

  test('clear() is an alias of destroy()', () => {
    const cache = new SnapshotCache();
    cache.set(makeKey(cache, 'find', 'F1'), 'x');
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  test('stats track hits/misses/evictions/entries', () => {
    const cache = new SnapshotCache({ maxEntries: 2 });
    const k1 = makeKey(cache, 'find', 'F1', 'a');
    const k2 = makeKey(cache, 'find', 'F1', 'b');
    cache.get(k1); // miss
    cache.set(k1, 1);
    cache.set(k2, 2);
    cache.set(makeKey(cache, 'find', 'F1', 'c'), 3); // evicts k1
    cache.get(k1); // miss after eviction
    cache.get(k2); // hit
    const s = cache.stats();
    expect(s.misses).toBeGreaterThanOrEqual(2);
    expect(s.hits).toBeGreaterThanOrEqual(1);
    expect(s.evictions).toBeGreaterThanOrEqual(1);
    expect(s.entries).toBe(2);
  });
});

describe('snapshot-cache helper — CDP subscriber retries', () => {
  const oldEnv = process.env.OPENCHROME_SNAPSHOT_CACHE;

  afterEach(() => {
    if (oldEnv === undefined) {
      delete process.env.OPENCHROME_SNAPSHOT_CACHE;
    } else {
      process.env.OPENCHROME_SNAPSHOT_CACHE = oldEnv;
    }
  });

  test('transient createCDPSession failure does not permanently mark page attached', async () => {
    process.env.OPENCHROME_SNAPSHOT_CACHE = '1';
    let attempts = 0;
    const page = {
      target: () => ({
        _targetId: 'target-retry',
        createCDPSession: async () => {
          attempts++;
          if (attempts === 1) throw new Error('temporary attach failure');
          return {
            send: jest.fn().mockResolvedValue(undefined),
            on: jest.fn(),
            detach: jest.fn().mockResolvedValue(undefined),
          };
        },
      }),
      mainFrame: () => ({ _id: 'frame-retry' }),
      viewport: () => ({ width: 1280, height: 720, deviceScaleFactor: 1 }),
      once: jest.fn(),
    };

    expect(getCacheForPage(page as never)).not.toBeNull();
    await Promise.resolve();
    expect(getCacheForPage(page as never)).not.toBeNull();
    await Promise.resolve();

    expect(attempts).toBe(2);
  });
});
