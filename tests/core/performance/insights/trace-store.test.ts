/// <reference types="jest" />

/**
 * Tests for the session-scoped performance trace store (#846).
 *
 * Covers:
 *  - store() persists a gzipped JSONL file under the configured rootDir
 *  - load() round-trips events and metadata
 *  - getHandle() returns the byte_size + trace_path
 *  - evictSession() removes every handle owned by the session and
 *    deletes the underlying files
 *  - evictTrace() removes one handle and its file
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PerfTraceStore } from '../../../../src/core/performance/insights/trace-store';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'perf-trace-store-'));
}

describe('PerfTraceStore.store / load round-trip', () => {
  test('persists events and reloads them in order', () => {
    const rootDir = mkRoot();
    const store = new PerfTraceStore({ rootDir });
    const events = [
      { name: 'A', cat: 'x', ph: 'I', ts: 1 },
      { name: 'B', cat: 'x', ph: 'I', ts: 2 },
    ];
    const handle = store.store({ sessionId: 's-1', events, metadata: { url: 'https://x.test' } });
    expect(handle.session_id).toBe('s-1');
    expect(handle.byte_size).toBeGreaterThan(0);
    expect(fs.existsSync(handle.trace_path)).toBe(true);
    expect(handle.trace_path.startsWith(rootDir)).toBe(true);

    const trace = store.load(handle.trace_id);
    expect(trace.traceEvents.map((e) => e.name)).toEqual(['A', 'B']);
    expect(trace.metadata).toEqual({ url: 'https://x.test' });
  });

  test('store() rejects empty session_id', () => {
    const store = new PerfTraceStore({ rootDir: mkRoot() });
    expect(() => store.store({ sessionId: '', events: [] })).toThrow(/sessionId is required/);
  });

  test('load() throws on unknown trace_id', () => {
    const store = new PerfTraceStore({ rootDir: mkRoot() });
    expect(() => store.load('00000000-0000-0000-0000-000000000000')).toThrow(/unknown trace_id/);
  });
});

describe('PerfTraceStore.evictSession', () => {
  test('removes every handle owned by the session and deletes files', () => {
    const rootDir = mkRoot();
    const store = new PerfTraceStore({ rootDir });
    const a = store.store({ sessionId: 's-1', events: [{ name: 'a' }] });
    const b = store.store({ sessionId: 's-1', events: [{ name: 'b' }] });
    const c = store.store({ sessionId: 's-2', events: [{ name: 'c' }] });

    expect(store.size()).toBe(3);
    const removed = store.evictSession('s-1');
    expect(removed).toBe(2);
    expect(store.size()).toBe(1);

    expect(fs.existsSync(a.trace_path)).toBe(false);
    expect(fs.existsSync(b.trace_path)).toBe(false);
    expect(fs.existsSync(c.trace_path)).toBe(true);
    expect(store.getHandle(c.trace_id)).toBeDefined();
    expect(store.getHandle(a.trace_id)).toBeUndefined();
  });

  test('evicting an unknown session is a no-op', () => {
    const store = new PerfTraceStore({ rootDir: mkRoot() });
    expect(store.evictSession('does-not-exist')).toBe(0);
  });
});

describe('PerfTraceStore.evictTrace', () => {
  test('removes the named handle and its file', () => {
    const rootDir = mkRoot();
    const store = new PerfTraceStore({ rootDir });
    const a = store.store({ sessionId: 's-1', events: [{ name: 'a' }] });
    expect(store.evictTrace(a.trace_id)).toBe(true);
    expect(fs.existsSync(a.trace_path)).toBe(false);
    expect(store.getHandle(a.trace_id)).toBeUndefined();
    expect(store.evictTrace(a.trace_id)).toBe(false);
  });
});
