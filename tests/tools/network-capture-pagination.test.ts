import {
  paginateNetworkCaptureEntries,
} from '../../src/tools/network-capture-shared';
import type { NetworkCaptureEntry } from '../../src/core/network-capture/types';

function entry(i: number): NetworkCaptureEntry {
  return {
    requestId: `req-${i}`,
    loaderId: 'loader-1',
    url: `https://example.test/assets/${i}.js`,
    method: 'GET',
    resourceType: i % 2 === 0 ? 'script' : 'xhr',
    status: 200,
    statusText: 'OK',
    requestHeaders: {},
    responseHeaders: {},
    timing: { startedAt: 1_700_000_000_000 + i, finishedAt: 1_700_000_000_100 + i },
    body: { mode: 'omitted', reason: 'lite_mode' },
  };
}

describe('network_capture cursor pagination (#881)', () => {
  test('paginates network capture entries with opaque nextCursor', () => {
    const entries = Array.from({ length: 125 }, (_, i) => entry(i));

    const first = paginateNetworkCaptureEntries(entries, { pageSize: 100 });
    expect(first.entries).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(125);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = paginateNetworkCaptureEntries(entries, { pageSize: 100, cursor: first.nextCursor });
    expect(second.entries).toHaveLength(25);
    expect(second.entries[0].requestId).toBe('req-100');
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  test('marks stale network cursors when retained entries change', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(i));
    const first = paginateNetworkCaptureEntries(entries, { pageSize: 10 });

    const changed = entries.slice();
    changed[0] = { ...changed[0], url: 'https://example.test/changed' };
    const stale = paginateNetworkCaptureEntries(changed, { pageSize: 10, cursor: first.nextCursor });

    expect(stale.staleCursor).toBe(true);
    expect(stale.entries).toEqual([]);
  });

  test('invalid cursors are reported for the tool layer', () => {
    const entries = [entry(1)];
    const result = paginateNetworkCaptureEntries(entries, { pageSize: 10, cursor: 'not-a-cursor' });

    expect(result.invalidCursor).toBeDefined();
    expect(result.entries).toEqual([]);
  });
});
