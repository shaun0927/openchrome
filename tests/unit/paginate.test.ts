/**
 * Tests for the standard pagination helper (#881).
 *
 * Validates the contract documented in src/utils/paginate.ts:
 *   - Cursor round-trip (encode → decode preserves offset/hash).
 *   - Page slicing is correct and yields concat-reconstruction.
 *   - hasMore correctly mirrors nextCursor presence.
 *   - Stale-cursor detection when contentHash diverges.
 *   - Malformed cursor throws `invalid_cursor`.
 *   - Edge cases: empty input, pageSize > total, last-page exactness.
 */

import {
  encodeCursor,
  decodeCursor,
  paginate,
  summarizeCursor,
} from '../../src/utils/paginate';

describe('cursor encode/decode', () => {
  test('round-trip preserves offset', () => {
    const c = encodeCursor({ offset: 42 });
    expect(decodeCursor(c).offset).toBe(42);
  });

  test('round-trip preserves hash', () => {
    const c = encodeCursor({ offset: 100, hash: 'abc123' });
    const s = decodeCursor(c);
    expect(s.offset).toBe(100);
    expect(s.hash).toBe('abc123');
  });

  test('rejects negative offset on encode', () => {
    expect(() => encodeCursor({ offset: -1 })).toThrow(/non-negative/);
  });

  test('rejects non-integer offset on encode', () => {
    expect(() => encodeCursor({ offset: 1.5 })).toThrow(/non-negative integer/);
  });

  test('rejects malformed cursor on decode', () => {
    expect(() => decodeCursor('not-a-base64-json')).toThrow('invalid_cursor');
    // Valid base64 but bad JSON
    const badJson = Buffer.from('not json', 'utf8').toString('base64url');
    expect(() => decodeCursor(badJson)).toThrow('invalid_cursor');
    // Valid JSON but wrong shape
    const wrongShape = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(wrongShape)).toThrow('invalid_cursor');
    // Valid JSON but old version
    const oldVer = Buffer.from(JSON.stringify({ v: 0, offset: 1 }), 'utf8').toString('base64url');
    expect(() => decodeCursor(oldVer)).toThrow('invalid_cursor');
  });
});

describe('paginate()', () => {
  const items = Array.from({ length: 25 }, (_, i) => `item-${i}`);

  test('first page (no cursor)', () => {
    const r = paginate(items, { pageSize: 10 });
    expect(r.items).toEqual(items.slice(0, 10));
    expect(r.hasMore).toBe(true);
    expect(r.total).toBe(25);
    expect(r.nextCursor).toBeDefined();
  });

  test('mid page (with cursor)', () => {
    const r1 = paginate(items, { pageSize: 10 });
    const r2 = paginate(items, { pageSize: 10, cursor: r1.nextCursor });
    expect(r2.items).toEqual(items.slice(10, 20));
    expect(r2.hasMore).toBe(true);
  });

  test('last page — hasMore=false, nextCursor undefined', () => {
    const r1 = paginate(items, { pageSize: 10 });
    const r2 = paginate(items, { pageSize: 10, cursor: r1.nextCursor });
    const r3 = paginate(items, { pageSize: 10, cursor: r2.nextCursor });
    expect(r3.items).toEqual(items.slice(20, 25));
    expect(r3.hasMore).toBe(false);
    expect(r3.nextCursor).toBeUndefined();
  });

  test('reconstruction — concatenating pages restores the full set', () => {
    const collected: string[] = [];
    let cursor: string | undefined = undefined;
    let safety = 100;
    while (safety-- > 0) {
      const r: ReturnType<typeof paginate<string>> = paginate(items, { pageSize: 7, cursor });
      collected.push(...r.items);
      if (!r.hasMore) break;
      cursor = r.nextCursor;
    }
    expect(collected).toEqual(items);
  });

  test('empty input — total=0, hasMore=false', () => {
    const r = paginate([], { pageSize: 10 });
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(r.total).toBe(0);
    expect(r.nextCursor).toBeUndefined();
  });

  test('pageSize > total — single page, no continuation', () => {
    const r = paginate(items, { pageSize: 1000 });
    expect(r.items.length).toBe(25);
    expect(r.hasMore).toBe(false);
  });

  test('rejects pageSize <= 0', () => {
    expect(() => paginate(items, { pageSize: 0 })).toThrow(/positive integer/);
    expect(() => paginate(items, { pageSize: -5 })).toThrow(/positive integer/);
  });

  test('stale cursor — content hash mismatch surfaces staleCursor:true', () => {
    const r1 = paginate(items, { pageSize: 10, contentHash: 'v1' });
    expect(r1.nextCursor).toBeDefined();
    // Underlying input changes; caller now passes the SAME cursor but a NEW hash.
    const r2 = paginate(items, { pageSize: 10, cursor: r1.nextCursor, contentHash: 'v2' });
    expect(r2.staleCursor).toBe(true);
    expect(r2.items).toEqual([]);
  });

  test('matching content hash does NOT trigger staleCursor', () => {
    const r1 = paginate(items, { pageSize: 10, contentHash: 'v1' });
    const r2 = paginate(items, { pageSize: 10, cursor: r1.nextCursor, contentHash: 'v1' });
    expect(r2.staleCursor).toBeUndefined();
    expect(r2.items.length).toBeGreaterThan(0);
  });
});

describe('summarizeCursor()', () => {
  test('returns "(none)" for undefined', () => {
    expect(summarizeCursor(undefined)).toBe('(none)');
  });

  test('formats a real cursor', () => {
    const c = encodeCursor({ offset: 100, hash: 'abcdef0123' });
    expect(summarizeCursor(c)).toContain('offset=100');
    expect(summarizeCursor(c)).toContain('hash=abcdef01');
  });

  test('returns "(invalid)" for malformed input', () => {
    expect(summarizeCursor('not-a-cursor')).toBe('cursor(invalid)');
  });
});
