/**
 * Tests for IdempotencyCache (issue #791, Phase 3).
 *
 * Covers:
 *   - Cache hit returns cached verdict
 *   - Cache miss returns undefined
 *   - TTL expiry returns undefined (lazy purge)
 *   - Different args produce different keys
 *   - Key is stable across object property order variation
 *   - Only success verdicts are cached (non-success is dropped)
 *   - cancelInflight returns false when no entry, true when found
 *   - registerInflight / releaseInflight lifecycle
 */

import {
  IdempotencyCache,
  canonicalJson,
  DEFAULT_CACHE_TTL_MS,
} from '../../../src/pilot/runtime/idempotency.js';
import type { TransactionRecord } from '../../../src/pilot/runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    txn_id: 'txn-test',
    contract_id: 'test-contract',
    verdict: 'success',
    started_at: 1000,
    ended_at: 1100,
    wall_ms: 100,
    retries: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('produces stable output regardless of object key order', () => {
    const a = canonicalJson({ b: 2, a: 1 });
    const b = canonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('sorts nested object keys recursively', () => {
    const result = canonicalJson({ z: { y: 1, x: 2 }, a: 0 });
    expect(result).toBe('{"a":0,"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    const result = canonicalJson([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });
});

// ---------------------------------------------------------------------------
// IdempotencyCache.key
// ---------------------------------------------------------------------------

describe('IdempotencyCache.key', () => {
  it('returns a 64-char hex string', () => {
    const cache = new IdempotencyCache();
    const k = cache.key('c1', { x: 1 });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different args produce different keys', () => {
    const cache = new IdempotencyCache();
    const k1 = cache.key('c1', { order_id: 42 });
    const k2 = cache.key('c1', { order_id: 43 });
    expect(k1).not.toBe(k2);
  });

  it('key is stable across object property order variation', () => {
    const cache = new IdempotencyCache();
    const k1 = cache.key('c1', { b: 2, a: 1 });
    const k2 = cache.key('c1', { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  it('different contractIds produce different keys even with same args', () => {
    const cache = new IdempotencyCache();
    const k1 = cache.key('contract-a', { x: 1 });
    const k2 = cache.key('contract-b', { x: 1 });
    expect(k1).not.toBe(k2);
  });

  it('undefined args and null args produce the same key', () => {
    const cache = new IdempotencyCache();
    const k1 = cache.key('c1', undefined);
    const k2 = cache.key('c1');
    expect(k1).toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// IdempotencyCache.lookup / record
// ---------------------------------------------------------------------------

describe('IdempotencyCache lookup and record', () => {
  it('returns undefined on cache miss', () => {
    const cache = new IdempotencyCache();
    expect(cache.lookup('nonexistent')).toBeUndefined();
  });

  it('returns cached verdict on hit within TTL', () => {
    let t = 1000;
    const cache = new IdempotencyCache({ now: () => t });
    const record = makeRecord();
    const key = cache.key('c1', {});
    cache.record(key, record, 5000);

    t = 5999; // still within 5000ms TTL
    const result = cache.lookup(key);
    expect(result).toBeDefined();
    expect(result?.txn_id).toBe('txn-test');
    expect(result?.verdict).toBe('success');
  });

  it('returns undefined after TTL expiry (lazy purge)', () => {
    let t = 1000;
    const cache = new IdempotencyCache({ now: () => t });
    const record = makeRecord();
    const key = cache.key('c1', {});
    cache.record(key, record, 5000);

    t = 6001; // past 1000 + 5000
    expect(cache.lookup(key)).toBeUndefined();
    // Lazy purge: size should decrease after the expired lookup
    expect(cache.size()).toBe(0);
  });

  it('does not cache non-success verdicts', () => {
    const cache = new IdempotencyCache();
    const key = cache.key('c1', {});
    const failRecord = makeRecord({ verdict: 'execution_error' });
    cache.record(key, failRecord, 5000);
    expect(cache.lookup(key)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('does not cache when ttlMs <= 0', () => {
    const cache = new IdempotencyCache();
    const key = cache.key('c1', {});
    cache.record(key, makeRecord(), 0);
    expect(cache.lookup(key)).toBeUndefined();
  });

  it('uses DEFAULT_CACHE_TTL_MS when ttlMs not supplied', () => {
    let t = 0;
    const cache = new IdempotencyCache({ now: () => t });
    const key = cache.key('c1', {});
    cache.record(key, makeRecord()); // no explicit ttl

    t = DEFAULT_CACHE_TTL_MS - 1;
    expect(cache.lookup(key)).toBeDefined();

    t = DEFAULT_CACHE_TTL_MS + 1;
    expect(cache.lookup(key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IdempotencyCache.cancelInflight
// ---------------------------------------------------------------------------

describe('IdempotencyCache.cancelInflight', () => {
  it('returns false when no in-flight entry exists', () => {
    const cache = new IdempotencyCache();
    expect(cache.cancelInflight('missing-key')).toBe(false);
  });

  it('returns true and aborts the signal when an in-flight entry exists', () => {
    const cache = new IdempotencyCache();
    const key = 'key-inflight';
    const promise = Promise.resolve(makeRecord());
    const signal = cache.registerInflight(key, 1, promise);

    expect(signal.aborted).toBe(false);
    const result = cache.cancelInflight(key);
    expect(result).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('returns false after cancelInflight already removed the entry', () => {
    const cache = new IdempotencyCache();
    const key = 'key-double-cancel';
    cache.registerInflight(key, 1, Promise.resolve(makeRecord()));
    cache.cancelInflight(key);
    expect(cache.cancelInflight(key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IdempotencyCache.registerInflight / releaseInflight
// ---------------------------------------------------------------------------

describe('IdempotencyCache registerInflight and releaseInflight', () => {
  it('registers and returns a non-aborted signal', () => {
    const cache = new IdempotencyCache();
    const signal = cache.registerInflight('key1', 0, Promise.resolve(makeRecord()));
    expect(signal.aborted).toBe(false);
  });

  it('releaseInflight removes the entry so getInflight returns undefined', () => {
    const cache = new IdempotencyCache();
    const key = 'key-release';
    cache.registerInflight(key, 0, Promise.resolve(makeRecord()));
    expect(cache.getInflight(key)).toBeDefined();
    cache.releaseInflight(key, 0);
    expect(cache.getInflight(key)).toBeUndefined();
  });

  it('releaseInflight is a no-op for mismatched epoch', () => {
    const cache = new IdempotencyCache();
    const key = 'key-epoch-mismatch';
    cache.registerInflight(key, 2, Promise.resolve(makeRecord()));
    cache.releaseInflight(key, 1); // wrong epoch — should not remove
    expect(cache.getInflight(key)).toBeDefined();
  });

  it('higher epoch aborts the lower-epoch in-flight signal', () => {
    const cache = new IdempotencyCache();
    const key = 'key-supersede';
    const p1 = Promise.resolve(makeRecord());
    const p2 = Promise.resolve(makeRecord());
    const sig1 = cache.registerInflight(key, 1, p1);
    const sig2 = cache.registerInflight(key, 2, p2); // should preempt epoch 1
    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(false);
  });

  it('lower epoch is immediately aborted when higher epoch is already registered', () => {
    const cache = new IdempotencyCache();
    const key = 'key-stale';
    cache.registerInflight(key, 5, Promise.resolve(makeRecord())); // high epoch first
    const stale = cache.registerInflight(key, 3, Promise.resolve(makeRecord())); // stale
    expect(stale.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IdempotencyCache.clear / size
// ---------------------------------------------------------------------------

describe('IdempotencyCache.clear and size', () => {
  it('size returns 0 for empty cache', () => {
    expect(new IdempotencyCache().size()).toBe(0);
  });

  it('size increments after record', () => {
    const cache = new IdempotencyCache();
    cache.record(cache.key('c', {}), makeRecord());
    expect(cache.size()).toBe(1);
  });

  it('clear empties cache entries and aborts in-flight entries', () => {
    const cache = new IdempotencyCache();
    cache.record(cache.key('c', {}), makeRecord());
    const sig = cache.registerInflight('k', 0, Promise.resolve(makeRecord()));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.getInflight('k')).toBeUndefined();
    expect(sig.aborted).toBe(true);
  });
});
