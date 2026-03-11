/// <reference types="jest" />
/**
 * Unit tests for SnapshotStore — Strategy 3: Incremental Delta Responses
 *
 * Tests cover:
 *   - Basic cache operations: set, get, TTL, LRU eviction, invalidate, clear, singleton
 *   - Delta computation: identical, small change, large change, URL change,
 *     added/removed lines, header format, caps, empty line skipping
 *   - Edge cases: empty content, LRU refresh on access
 */

import { SnapshotStore } from '../../src/compression/snapshot-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a snapshot content string from an array of lines.
 * Non-empty lines become content; empty strings produce blank lines.
 */
function makeContent(lines: string[]): string {
  return lines.join('\n');
}

/** Generate N distinct non-empty lines. */
function makeLines(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

// ---------------------------------------------------------------------------
// Basic Cache Operations
// ---------------------------------------------------------------------------

describe('SnapshotStore — basic cache operations', () => {
  let store: SnapshotStore;

  beforeEach(() => {
    store = SnapshotStore.getInstance();
    store.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('set and get — stored snapshot is retrievable', () => {
    store.set('session1', 'tab1', 'hello world', 'https://example.com');
    const snap = store.get('session1', 'tab1');
    expect(snap).not.toBeNull();
    expect(snap!.content).toBe('hello world');
    expect(snap!.pageUrl).toBe('https://example.com');
  });

  test('get returns null for missing key', () => {
    const result = store.get('nonexistent-session', 'nonexistent-tab');
    expect(result).toBeNull();
  });

  test('TTL expiry — get returns null after 30 seconds', () => {
    jest.useFakeTimers();
    store.set('session1', 'tab1', 'some content', 'https://example.com');

    // Advance past the 30-second TTL
    jest.advanceTimersByTime(30_001);

    const snap = store.get('session1', 'tab1');
    expect(snap).toBeNull();
  });

  test('TTL not expired — get returns snapshot within TTL window', () => {
    jest.useFakeTimers();
    store.set('session1', 'tab1', 'some content', 'https://example.com');

    // Advance to just before expiry
    jest.advanceTimersByTime(29_999);

    const snap = store.get('session1', 'tab1');
    expect(snap).not.toBeNull();
  });

  test('LRU eviction at capacity — oldest entry evicted when adding 51st', () => {
    // Fill all 50 slots with distinct keys
    for (let i = 0; i < 50; i++) {
      store.set('session', `tab-${i}`, `content-${i}`, 'https://example.com');
    }

    // Confirm the first entry is still present before eviction
    expect(store.get('session', 'tab-0')).not.toBeNull();

    // Adding the 51st entry should evict tab-0 (oldest)
    store.set('session', 'tab-50', 'content-50', 'https://example.com');

    expect(store.get('session', 'tab-0')).toBeNull();
    expect(store.get('session', 'tab-50')).not.toBeNull();
  });

  test('invalidate removes specific entry', () => {
    store.set('session1', 'tab1', 'content', 'https://example.com');
    store.set('session1', 'tab2', 'other', 'https://example.com');

    store.invalidate('session1', 'tab1');

    expect(store.get('session1', 'tab1')).toBeNull();
    // Other entry unaffected
    expect(store.get('session1', 'tab2')).not.toBeNull();
  });

  test('clear removes all entries', () => {
    store.set('s1', 't1', 'a', 'https://a.com');
    store.set('s2', 't2', 'b', 'https://b.com');
    store.set('s3', 't3', 'c', 'https://c.com');

    store.clear();

    expect(store.get('s1', 't1')).toBeNull();
    expect(store.get('s2', 't2')).toBeNull();
    expect(store.get('s3', 't3')).toBeNull();
  });

  test('singleton pattern — getInstance returns the same instance', () => {
    const a = SnapshotStore.getInstance();
    const b = SnapshotStore.getInstance();
    expect(a).toBe(b);
  });

  test('move to end for LRU — accessing existing key refreshes its position', () => {
    // Fill 50 slots
    for (let i = 0; i < 50; i++) {
      store.set('session', `tab-${i}`, `content-${i}`, 'https://example.com');
    }

    // Re-set tab-0 to move it to the end (most recently used)
    store.set('session', 'tab-0', 'refreshed', 'https://example.com');

    // Now adding tab-50 should evict tab-1 (the new oldest), not tab-0
    store.set('session', 'tab-50', 'new-content', 'https://example.com');

    expect(store.get('session', 'tab-0')).not.toBeNull();
    expect(store.get('session', 'tab-1')).toBeNull();
    expect(store.get('session', 'tab-50')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delta Computation
// ---------------------------------------------------------------------------

describe('SnapshotStore — computeDelta', () => {
  let store: SnapshotStore;

  beforeEach(() => {
    store = SnapshotStore.getInstance();
    store.clear();
  });

  /** Build a minimal Snapshot-like object via set+get. */
  function makeSnapshot(content: string, url = 'https://example.com') {
    store.set('delta-session', 'delta-tab', content, url);
    return store.get('delta-session', 'delta-tab')!;
  }

  test('identical content — isDelta: true, changeRatio: 0, no added/removed', () => {
    const content = makeContent(makeLines(20));
    const snap = makeSnapshot(content);

    const result = store.computeDelta(snap, content, 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.changeRatio).toBe(0);
    expect(result.stats.addedLines).toBe(0);
    expect(result.stats.removedLines).toBe(0);
    expect(result.stats.unchangedLines).toBe(20);
  });

  test('small change — 1 line changed out of 20 → isDelta: true, small changeRatio', () => {
    const original = makeLines(20);
    const modified = [...original];
    modified[10] = 'completely-different-line';

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(modified), 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.changeRatio).toBeGreaterThan(0);
    expect(result.changeRatio).toBeLessThanOrEqual(0.5);
    expect(result.stats.addedLines).toBe(1);
    expect(result.stats.removedLines).toBe(1);
  });

  test('large change (>50%) — isDelta: false, full content returned', () => {
    // 2 original lines, 20 new distinct lines → change ratio > 0.5
    const original = makeLines(2, 'old');
    const current = makeLines(20, 'new');

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(false);
    expect(result.content).toBe(makeContent(current));
    expect(result.changeRatio).toBeGreaterThan(0.5);
  });

  test('URL change — isDelta: false, changeRatio: 1.0', () => {
    const snap = makeSnapshot('some content', 'https://page-a.com');

    const result = store.computeDelta(snap, 'different content', 'https://page-b.com');

    expect(result.isDelta).toBe(false);
    expect(result.changeRatio).toBe(1.0);
    expect(result.content).toBe('different content');
  });

  test('added lines — delta output includes lines prefixed with "+ "', () => {
    const original = makeLines(10, 'existing');
    const current = [...original, 'brand-new-line-A', 'brand-new-line-B'];

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.stats.addedLines).toBe(2);
    expect(result.content).toContain('+ brand-new-line-A');
    expect(result.content).toContain('+ brand-new-line-B');
  });

  test('removed lines — delta output includes lines prefixed with "- "', () => {
    const original = [...makeLines(10, 'keep'), 'remove-me-A', 'remove-me-B'];
    const current = makeLines(10, 'keep');

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.stats.removedLines).toBe(2);
    expect(result.content).toContain('- remove-me-A');
    expect(result.content).toContain('- remove-me-B');
  });

  test('delta header format — "[DOM Delta — N of M nodes changed]"', () => {
    const original = makeLines(20, 'base');
    const current = [...original.slice(0, 18), 'replaced-A', 'replaced-B'];

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(true);
    // Header: [DOM Delta — <added+removed> of <totalPrevLines> nodes changed]
    expect(result.content).toMatch(/^\[DOM Delta — \d+ of \d+ nodes changed\]/);
  });

  test('unchanged count — "Unchanged: N nodes (X%)" appears in delta output', () => {
    const original = makeLines(20, 'stable');
    const current = [...original.slice(0, 19), 'one-new-line'];

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.content).toMatch(/Unchanged: \d+ nodes \(\d+%\)/);
    expect(result.stats.unchangedLines).toBe(19);
  });

  test('added lines capped at 20 — overflow shows "... and N more"', () => {
    // Keep 5 original lines, add 30 new ones → change ratio low enough for delta
    // Use large base to keep changeRatio under threshold
    const base = makeLines(100, 'keep');
    const extraAdded = makeLines(30, 'added');
    const current = [...base, ...extraAdded];

    const snap = makeSnapshot(makeContent(base));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.stats.addedLines).toBe(30);
    // Only first 20 shown, remainder summarised
    expect(result.content).toContain('... and 10 more');
  });

  test('removed lines capped at 10 — overflow shows "... and N more"', () => {
    // Large base with 15 lines to be removed; keep enough to stay under threshold
    const kept = makeLines(100, 'keep');
    const toRemove = makeLines(15, 'remove');
    const original = [...kept, ...toRemove];
    const current = [...kept];

    const snap = makeSnapshot(makeContent(original));
    const result = store.computeDelta(snap, makeContent(current), 'https://example.com');

    expect(result.isDelta).toBe(true);
    expect(result.stats.removedLines).toBe(15);
    expect(result.content).toContain('... and 5 more');
  });

  test('empty lines skipped — blank lines do not count in diff', () => {
    // Content with blank lines interspersed; only non-blank lines matter
    const withBlanks = 'line-1\n\nline-2\n\nline-3\n';
    const snap = makeSnapshot(withBlanks);

    const result = store.computeDelta(snap, withBlanks, 'https://example.com');

    expect(result.isDelta).toBe(true);
    // Blank lines are ignored; identical non-blank content → no changes
    expect(result.stats.addedLines).toBe(0);
    expect(result.stats.removedLines).toBe(0);
  });

  test('empty content — both empty → isDelta: true, changeRatio: 1.0 (no prev lines), no added/removed', () => {
    const snap = makeSnapshot('');
    const result = store.computeDelta(snap, '', 'https://example.com');

    // totalPrevLines = 0, formula returns 1.0 — but changeRatio > 0.5 so isDelta: false
    // OR: if added=0 and removed=0, changeRatio could be 0. Depends on implementation.
    // The source: changeRatio = totalPrevLines > 0 ? ... : 1.0
    // With empty content, totalPrevLines = 0 → changeRatio = 1.0 → isDelta: false
    expect(result.isDelta).toBe(false);
    expect(result.changeRatio).toBe(1.0);
    expect(result.stats.addedLines).toBe(0);
    expect(result.stats.removedLines).toBe(0);
  });
});
