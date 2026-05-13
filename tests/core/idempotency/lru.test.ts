/// <reference types="jest" />

import { LruTtlCache } from '../../../src/core/idempotency/lru';

describe('LruTtlCache', () => {
  test('expires entries by TTL', () => {
    let now = 1000;
    const evictions: string[] = [];
    const cache = new LruTtlCache<string>({ maxEntries: 2, ttlMs: 100, now: () => now, onEvict: (r) => evictions.push(r) });
    cache.set('a', 'A');
    now = 1099;
    expect(cache.get('a')).toBe('A');
    now = 1200;
    expect(cache.get('a')).toBeUndefined();
    expect(evictions).toContain('ttl');
  });

  test('evicts least recently used entry at bound', () => {
    let now = 0;
    const evictions: string[] = [];
    const cache = new LruTtlCache<string>({ maxEntries: 2, ttlMs: 1000, now: () => now, onEvict: (r) => evictions.push(r) });
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.get('a')).toBe('A');
    now = 1;
    cache.set('c', 'C');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(evictions).toContain('lru');
  });
});
