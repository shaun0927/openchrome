import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TraceRecorder, _resetTraceRecorderForTests, getTraceRecorder } from '../../src/trace/recorder';
import { TraceStorage } from '../../src/trace/storage';
import type { TraceEvent } from '../../src/trace/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rec-'));
}

function makeRecorder(opts: { storage: TraceStorage; bufferSize?: number; flushIntervalMs?: number; capacityFlushRatio?: number; }): TraceRecorder {
  return new TraceRecorder({
    storage: opts.storage,
    bufferSize: opts.bufferSize ?? 8,
    flushIntervalMs: opts.flushIntervalMs ?? 24 * 60 * 60 * 1000, // effectively disable timer in unit tests
    capacityFlushRatio: opts.capacityFlushRatio ?? 0.5,
    enabled: true,
    now: () => 1700000000000,
  });
}

describe('TraceRecorder — disabled by default when env not set', () => {
  test('isEnabled() reflects OPENCHROME_TRACE env', () => {
    const prev = process.env.OPENCHROME_TRACE;
    delete process.env.OPENCHROME_TRACE;
    const r1 = new TraceRecorder({ storage: new TraceStorage({ rootDir: tempRoot() }) });
    expect(r1.isEnabled()).toBe(false);

    process.env.OPENCHROME_TRACE = '1';
    const r2 = new TraceRecorder({ storage: new TraceStorage({ rootDir: tempRoot() }) });
    expect(r2.isEnabled()).toBe(true);

    process.env.OPENCHROME_TRACE = prev ?? '';
    if (!prev) delete process.env.OPENCHROME_TRACE;
  });

  test('disabled recorder is a no-op for start / recordEvent / flush', async () => {
    const root = tempRoot();
    const storage = new TraceStorage({ rootDir: root });
    const r = new TraceRecorder({ storage, enabled: false });
    r.start({ sessionId: 's', startedAt: 1, domain: 'x' });
    r.recordEvent('s', 'k', { x: 1 });
    await r.flush('s');
    await r.end('s');
    expect(storage.list()).toHaveLength(0);
    storage.close();
  });
});

describe('TraceRecorder — start / recordEvent / flush', () => {
  let root: string;
  let storage: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new TraceStorage({ rootDir: root });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('start() registers session in the index', () => {
    const r = makeRecorder({ storage });
    r.start({ sessionId: 's1', startedAt: 100, domain: 'amazon.com' });
    expect(storage.get('s1')?.status).toBe('running');
    expect(storage.get('s1')?.domain).toBe('amazon.com');
  });

  test('recordEvent buffers events and flushes on capacity threshold', async () => {
    const r = makeRecorder({ storage, bufferSize: 4, capacityFlushRatio: 0.5 }); // flush at >= 2
    r.start({ sessionId: 's1', startedAt: 100 });
    r.recordEvent('s1', 'a', { i: 1 });
    // Buffer should still contain 1 event (below threshold)
    expect(r._peekBuffer('s1')).toHaveLength(1);
    r.recordEvent('s1', 'b', { i: 2 });
    // Capacity flush is async — give it a tick
    await new Promise((res) => setImmediate(res));
    expect(r._peekBuffer('s1')).toHaveLength(0);
    expect(storage.get('s1')?.byteSize).toBeGreaterThan(0);
  });

  test('manual flush writes the buffer and updates byte_size', async () => {
    const r = makeRecorder({ storage, bufferSize: 100 }); // never auto-flushes
    r.start({ sessionId: 's2', startedAt: 100 });
    r.recordEvent('s2', 'k', { i: 1 });
    r.recordEvent('s2', 'k', { i: 2 });
    await r.flush('s2');
    expect(r._peekBuffer('s2')).toHaveLength(0);
    expect(storage.get('s2')?.byteSize).toBeGreaterThan(0);
  });

  test('redaction is applied at recordEvent time (sensitive keys scrubbed)', async () => {
    const r = makeRecorder({ storage, bufferSize: 100 });
    r.start({ sessionId: 's3', startedAt: 100 });
    r.recordEvent('s3', 'Network.requestWillBeSent', {
      request: { url: 'https://x/?password=hunter2', headers: { Authorization: 'Bearer secret' } },
    });
    const buf = r._peekBuffer('s3');
    const body = buf[0].body as { request: { url: string; headers: Record<string, string> } };
    expect(body.request.url).not.toContain('hunter2');
    expect(body.request.headers.Authorization).toBe('[REDACTED]');
  });

  test('recordEvent on unknown session is a silent drop (no throw)', () => {
    const r = makeRecorder({ storage });
    expect(() => r.recordEvent('nope', 'k', {})).not.toThrow();
  });
});

describe('TraceRecorder — attach to CDP-like emitter', () => {
  let root: string;
  let storage: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new TraceStorage({ rootDir: root });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('subscribes to default CDP kinds and records emitted events', async () => {
    const cdp = new EventEmitter();
    const r = makeRecorder({ storage, bufferSize: 100 });
    r.start({ sessionId: 's', startedAt: 100 });
    r.attach('s', cdp);
    cdp.emit('Page.frameNavigated', { frame: { url: 'https://x' } });
    cdp.emit('Network.responseReceived', { response: { status: 200 } });
    cdp.emit('Runtime.consoleAPICalled', { type: 'log' });
    expect(r._peekBuffer('s').map((e) => e.kind)).toEqual([
      'Page.frameNavigated',
      'Network.responseReceived',
      'Runtime.consoleAPICalled',
    ]);
  });

  test('detach via end() removes listeners; further CDP events are not buffered', async () => {
    const cdp = new EventEmitter();
    const r = makeRecorder({ storage, bufferSize: 100 });
    r.start({ sessionId: 's', startedAt: 100 });
    r.attach('s', cdp);
    cdp.emit('Page.frameNavigated', {});
    await r.end('s');
    cdp.emit('Page.frameNavigated', {});
    // Session is gone — no buffer to peek at.
    expect(r._peekBuffer('s')).toEqual([]);
    expect(storage.get('s')?.status).toBe('completed');
  });

  test('framenavigated on the page triggers a flush', async () => {
    const cdp = new EventEmitter();
    const page = new EventEmitter();
    const r = makeRecorder({ storage, bufferSize: 100 });
    r.start({ sessionId: 's', startedAt: 100 });
    r.attach('s', cdp, page as unknown as { on(e: string, fn: (...a: unknown[]) => void): unknown });
    r.recordEvent('s', 'tool_call', { name: 'click' });
    expect(r._peekBuffer('s')).toHaveLength(1);
    page.emit('framenavigated', { url: 'https://x' });
    await new Promise((res) => setImmediate(res));
    expect(r._peekBuffer('s')).toHaveLength(0);
  });

  test('attaching a session twice throws (defensive)', () => {
    const cdp = new EventEmitter();
    const r = makeRecorder({ storage });
    r.start({ sessionId: 's', startedAt: 100 });
    r.attach('s', cdp);
    expect(() => r.attach('s', cdp)).toThrow(/already attached/);
  });

  test('attach without start throws', () => {
    const cdp = new EventEmitter();
    const r = makeRecorder({ storage });
    expect(() => r.attach('nope', cdp)).toThrow(/unknown session/);
  });
});

describe('TraceRecorder — shutdown semantics', () => {
  let root: string;
  let storage: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new TraceStorage({ rootDir: root });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('shutdown flushes and ends every active session as aborted', async () => {
    const r = makeRecorder({ storage });
    r.start({ sessionId: 'a', startedAt: 1 });
    r.start({ sessionId: 'b', startedAt: 2 });
    r.recordEvent('a', 'k', {});
    r.recordEvent('b', 'k', {});
    await r.shutdown();
    expect(storage.get('a')?.status).toBe('aborted');
    expect(storage.get('b')?.status).toBe('aborted');
  });
});

describe('TraceRecorder — global singleton', () => {
  test('getTraceRecorder() returns the same instance across calls', () => {
    _resetTraceRecorderForTests();
    const a = getTraceRecorder({ enabled: false });
    const b = getTraceRecorder();
    expect(a).toBe(b);
    _resetTraceRecorderForTests();
  });
});
