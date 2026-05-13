/// <reference types="jest" />

/**
 * Tests for HandleStore (#887).
 *
 * Covers:
 *  - writeJson() stores a handle and saveMeta() persists sidecar
 *  - fetch() returns paginated content
 *  - fetch() returns null for unknown/expired handles
 *  - purgeExpired() removes expired handles and returns count
 *  - P2 fix: format:'items' on non-array payload returns FetchHandleFormatError
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { HandleStore, FetchHandleFormatError } from '../../../src/core/output/handle-store';
import type { OutputHandle } from '../../../src/core/output/handle-store.types';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'handle-store-'));
}

function isFetchFormatError(r: unknown): r is FetchHandleFormatError {
  return (
    typeof r === 'object' &&
    r !== null &&
    (r as FetchHandleFormatError).error === 'INVALID_FORMAT_FOR_PAYLOAD'
  );
}

describe('HandleStore.writeJson / fetch round-trip', () => {
  test('stores a JSON array payload and fetches items', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    const payload = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const meta = await store.writeJson(payload);
    await store.saveMeta(meta);

    expect(meta.output_handle).toMatch(/^oh_[A-Z2-7]{12}$/);
    expect(meta.mime_type).toBe('application/json');
    expect(meta.item_count).toBe(3);
    expect(meta.payload_type).toBe('json');

    const result = store.fetch(meta.output_handle as OutputHandle, { format: 'items' });
    expect(result).not.toBeNull();
    expect(isFetchFormatError(result)).toBe(false);
    if (result && !isFetchFormatError(result)) {
      expect(result.total).toBe(3);
      expect(result.content).toEqual(payload);
      expect(result.eof).toBe(true);
    }
  });

  test('paginates a large JSON array with offset and limit', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    const payload = Array.from({ length: 10 }, (_, i) => ({ i }));
    const meta = await store.writeJson(payload);
    await store.saveMeta(meta);

    const page1 = store.fetch(meta.output_handle as OutputHandle, { format: 'items', offset: 0, limit: 4 });
    expect(page1 && !isFetchFormatError(page1) && page1.returned).toBe(4);
    expect(page1 && !isFetchFormatError(page1) && page1.eof).toBe(false);
    expect(page1 && !isFetchFormatError(page1) && page1.next_offset).toBe(4);

    const page3 = store.fetch(meta.output_handle as OutputHandle, { format: 'items', offset: 8, limit: 4 });
    expect(page3 && !isFetchFormatError(page3) && page3.returned).toBe(2);
    expect(page3 && !isFetchFormatError(page3) && page3.eof).toBe(true);
    expect(page3 && !isFetchFormatError(page3) && page3.next_offset).toBeNull();
  });

  test('fetch() returns null for an unknown handle', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    const result = store.fetch('oh_AAAAAAAAAAAA' as OutputHandle);
    expect(result).toBeNull();
  });
});

describe('HandleStore.purgeExpired (P2-1 fix)', () => {
  test('purges files whose expires_at is in the past and returns count', async () => {
    const baseDir = mkRoot();
    const store = new HandleStore({ baseDir });
    // Write a handle with TTL of 0 hours so it expires immediately.
    const meta = await store.writeJson({ x: 1 }, { ttlHours: 0 });
    await store.saveMeta(meta);

    // Verify the files exist before purging.
    expect(fs.existsSync(meta.file_path)).toBe(true);

    const removed = store.purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    // Payload file should be gone.
    expect(fs.existsSync(meta.file_path)).toBe(false);
  });

  test('purgeExpired() returns 0 when no handles are expired', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    await store.writeJson({ alive: true }, { ttlHours: 24 }).then((m) => store.saveMeta(m));
    expect(store.purgeExpired()).toBe(0);
  });
});

describe('P2-2 fix: format:"items" rejected on non-array payload', () => {
  test('returns FetchHandleFormatError when payload is a JSON object', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    const meta = await store.writeJson({ key: 'value' });
    await store.saveMeta(meta);

    const result = store.fetch(meta.output_handle as OutputHandle, { format: 'items' });
    expect(isFetchFormatError(result)).toBe(true);
    if (isFetchFormatError(result)) {
      expect(result.error).toBe('INVALID_FORMAT_FOR_PAYLOAD');
      expect(typeof result.detail).toBe('string');
    }
  });

  test('format:"auto" on a JSON object falls back to bytes (no error)', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    const meta = await store.writeJson({ key: 'value' });
    await store.saveMeta(meta);

    const result = store.fetch(meta.output_handle as OutputHandle, { format: 'auto' });
    expect(result).not.toBeNull();
    expect(isFetchFormatError(result)).toBe(false);
  });

  test('format:"items" on a JSON array succeeds', async () => {
    const store = new HandleStore({ baseDir: mkRoot() });
    const meta = await store.writeJson([1, 2, 3]);
    await store.saveMeta(meta);

    const result = store.fetch(meta.output_handle as OutputHandle, { format: 'items' });
    expect(isFetchFormatError(result)).toBe(false);
    expect(result).not.toBeNull();
  });
});
