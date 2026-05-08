/**
 * Replay-server smoke tests for `oc trace play` (M1 PR-3 deferred slice).
 *
 * Spawns the in-process server (no subprocess), seeds an isolated trace
 * root via TraceStorage, and hits each endpoint to assert shape + bind
 * scope. Verifies 127.0.0.1-only binding by checking the listening
 * address rather than attempting cross-host connections.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startReplayServer } from '../../cli/replay-server';
import { TraceStorage } from '../../src/trace/storage';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-replay-'));
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body };
}

describe('replay server — endpoints', () => {
  let traceRootPath: string;
  let store: TraceStorage;
  let originalRoot: string | undefined;
  let handle: Awaited<ReturnType<typeof startReplayServer>>;

  beforeEach(async () => {
    traceRootPath = tempRoot();
    originalRoot = process.env.OPENCHROME_TRACE_ROOT;
    process.env.OPENCHROME_TRACE_ROOT = traceRootPath;
    store = new TraceStorage({ rootDir: traceRootPath });
    handle = await startReplayServer({ port: 0 });
  });

  afterEach(async () => {
    await handle.close();
    store.close();
    fs.rmSync(traceRootPath, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env.OPENCHROME_TRACE_ROOT;
    else process.env.OPENCHROME_TRACE_ROOT = originalRoot;
  });

  test('binds to 127.0.0.1 with an OS-assigned port', () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  test('GET / returns the static replay HTML', async () => {
    const res = await fetch(handle.url);
    const ct = res.headers.get('content-type') ?? '';
    expect(res.status).toBe(200);
    expect(ct).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('OpenChrome trace replay');
  });

  test('GET /api/trace/list returns [] for empty index', async () => {
    const r = await getJson(`${handle.url}api/trace/list`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect((r.body as unknown[]).length).toBe(0);
  });

  test('GET /api/trace/list reflects recorded sessions', async () => {
    store.recordSessionStart({
      sessionId: 's1',
      startedAt: 1000,
      domain: 'amazon.com',
      status: 'completed',
    });
    store.recordSessionStart({
      sessionId: 's2',
      startedAt: 2000,
      domain: 'github.com',
      status: 'failed',
    });
    const r = await getJson(`${handle.url}api/trace/list`);
    expect(r.status).toBe(200);
    const rows = r.body as Array<{ session_id: string; domain: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].session_id).toBe('s2');
    expect(rows[1].session_id).toBe('s1');
  });

  test('GET /api/trace/<id>/meta returns the index row', async () => {
    store.recordSessionStart({
      sessionId: 'meta-1',
      startedAt: 1234,
      domain: 'x.com',
      status: 'running',
    });
    const r = await getJson(`${handle.url}api/trace/meta-1/meta`);
    expect(r.status).toBe(200);
    expect((r.body as { session_id: string }).session_id).toBe('meta-1');
  });

  test('GET /api/trace/<id>/events returns events with total + returned counts', async () => {
    store.recordSessionStart({ sessionId: 'ev', startedAt: 1, status: 'running' });
    store.appendEvents('ev', [
      { ts: 100, seq: 1, kind: 'A', body: { ok: true } },
      { ts: 200, seq: 2, kind: 'B', body: { ok: false } },
      { ts: 300, seq: 3, kind: 'C', body: {} },
    ]);
    const r = await getJson(`${handle.url}api/trace/ev/events?limit=2`);
    expect(r.status).toBe(200);
    const body = r.body as { total: number; returned: number; events: Array<{ kind: string }> };
    expect(body.total).toBe(3);
    expect(body.returned).toBe(2);
    expect(body.events.map((e) => e.kind)).toEqual(['A', 'B']);
  });

  test('GET /api/trace/<id>/events honors from / to filters', async () => {
    store.recordSessionStart({ sessionId: 'f', startedAt: 1, status: 'running' });
    store.appendEvents('f', [
      { ts: 100, seq: 1, kind: 'A', body: {} },
      { ts: 200, seq: 2, kind: 'B', body: {} },
      { ts: 300, seq: 3, kind: 'C', body: {} },
    ]);
    const r = await getJson(`${handle.url}api/trace/f/events?from=150&to=250`);
    expect(r.status).toBe(200);
    const body = r.body as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['B']);
  });

  test('GET /api/trace/<unknown>/meta returns 404', async () => {
    store.recordSessionStart({ sessionId: 'real', startedAt: 1, status: 'completed' });
    const r = await getJson(`${handle.url}api/trace/missing/meta`);
    expect(r.status).toBe(404);
  });

  test('unknown path returns 404', async () => {
    const r = await getJson(`${handle.url}does/not/exist`);
    expect(r.status).toBe(404);
  });

  test('malformed percent-encoded session id is rejected with 400 (no crash)', async () => {
    // Regression: an unguarded `decodeURIComponent` on the session id let
    // a single bad local request kill the request handler with URIError,
    // which would terminate the listener until restart. The handler now
    // catches URIError and returns 400; the server remains live for the
    // follow-up request below.
    const r = await getJson(`${handle.url}api/trace/%E0%A4%A/meta`);
    expect(r.status).toBe(400);
    const r2 = await getJson(`${handle.url}api/trace/list`);
    expect(r2.status).toBe(200);
  });
});
