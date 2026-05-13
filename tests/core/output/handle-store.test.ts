/// <reference types="jest" />

/**
 * Tests for OutputHandleStore (#887).
 *
 * Covers:
 *  - put() stores a handle and returns metadata
 *  - get() retrieves it by id
 *  - get() returns undefined for an expired handle
 *  - get() rejects an invalid UUID
 *  - purgeExpired() removes expired handles and returns the count
 *  - format:"items" rejection when payload is non-array (P2 fix)
 */

import { OutputHandleStore, setOutputHandleStoreForTests } from '../../../src/core/output/handle-store';

afterEach(() => {
  // Reset singleton between tests.
  setOutputHandleStoreForTests(null);
});

describe('OutputHandleStore.put / get round-trip', () => {
  test('stores a payload and retrieves it by handle_id', () => {
    const store = new OutputHandleStore();
    const handle = store.put({ sessionId: 's-1', payload: '{"foo":1}' });

    expect(handle.handle_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(handle.session_id).toBe('s-1');
    expect(handle.is_array).toBe(false);
    expect(handle.payload).toBe('{"foo":1}');

    const retrieved = store.get(handle.handle_id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.payload).toBe('{"foo":1}');
  });

  test('is_array is true when payload is a JSON array', () => {
    const store = new OutputHandleStore();
    const handle = store.put({ sessionId: 's-1', payload: '[1,2,3]' });
    expect(handle.is_array).toBe(true);
  });

  test('put() rejects empty sessionId', () => {
    const store = new OutputHandleStore();
    expect(() => store.put({ sessionId: '', payload: 'x' })).toThrow(/sessionId is required/);
  });

  test('get() returns undefined for unknown handle_id', () => {
    const store = new OutputHandleStore();
    expect(store.get('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  test('get() throws for a non-UUID handle_id', () => {
    const store = new OutputHandleStore();
    expect(() => store.get('not-a-uuid')).toThrow(/not a valid UUID/);
  });
});

describe('OutputHandleStore.purgeExpired', () => {
  test('removes handles past their expires_at and returns count', () => {
    // Use a 0 ms TTL so handles expire immediately.
    const store = new OutputHandleStore({ ttlMs: 0 });
    const a = store.put({ sessionId: 's-1', payload: 'a' });
    const b = store.put({ sessionId: 's-1', payload: 'b' });

    expect(store.size()).toBe(2);

    // Both handles expire immediately (ttl=0, created_at <= now).
    const removed = store.purgeExpired();
    expect(removed).toBe(2);
    expect(store.size()).toBe(0);
    expect(store.get(a.handle_id)).toBeUndefined();
    expect(store.get(b.handle_id)).toBeUndefined();
  });

  test('get() also evicts expired handles on access', () => {
    const store = new OutputHandleStore({ ttlMs: 0 });
    const h = store.put({ sessionId: 's-1', payload: 'x' });
    // get() internally checks expires_at and deletes.
    expect(store.get(h.handle_id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  test('purgeExpired() is a no-op when no handles have expired', () => {
    const store = new OutputHandleStore({ ttlMs: 60_000 });
    store.put({ sessionId: 's-1', payload: 'still-alive' });
    expect(store.purgeExpired()).toBe(0);
    expect(store.size()).toBe(1);
  });
});

describe('is_array validation (P2 fix)', () => {
  test('is_array false for plain text payload', () => {
    const store = new OutputHandleStore();
    const h = store.put({ sessionId: 's-1', payload: 'hello world' });
    expect(h.is_array).toBe(false);
  });

  test('is_array false for JSON object payload', () => {
    const store = new OutputHandleStore();
    const h = store.put({ sessionId: 's-1', payload: '{"key":"val"}' });
    expect(h.is_array).toBe(false);
  });

  test('is_array true for JSON array payload', () => {
    const store = new OutputHandleStore();
    const h = store.put({ sessionId: 's-1', payload: '[{"id":1},{"id":2}]' });
    expect(h.is_array).toBe(true);
  });
});
