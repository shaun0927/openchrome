/**
 * Unit tests for the openchrome://trace/* MCP resources (M1 PR-7
 * deferred slice — closes the #704 "LLM can read trace via MCP" AC).
 *
 * Drives the resource module against an isolated trace root populated
 * via TraceStorage. Does not boot the full MCPServer — the server's
 * prefix-handler dispatch is exercised separately by existing
 * resources/list tests under tests/.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildTraceContent,
  buildTraceListPayload,
  parseTraceUri,
  readTraceResource,
  traceListResource,
} from '../../src/resources/trace-resource';
import { TraceStorage } from '../../src/trace/storage';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-res-'));
}

let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.OPENCHROME_TRACE_ROOT;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.OPENCHROME_TRACE_ROOT;
  else process.env.OPENCHROME_TRACE_ROOT = prevRoot;
});

describe('parseTraceUri', () => {
  test('returns null for the static list URI', () => {
    expect(parseTraceUri('openchrome://trace/list')).toBeNull();
  });

  test('returns null for non-trace URIs', () => {
    expect(parseTraceUri('openchrome://usage-guide')).toBeNull();
    expect(parseTraceUri('http://example.com/x')).toBeNull();
  });

  test('parses meta URIs', () => {
    expect(parseTraceUri('openchrome://trace/abc/meta')).toMatchObject({
      sessionId: 'abc',
      kind: 'meta',
    });
  });

  test('parses events URIs with query parameters', () => {
    const r = parseTraceUri('openchrome://trace/abc/events?from=100&to=200&limit=10')!;
    expect(r.sessionId).toBe('abc');
    expect(r.kind).toBe('events');
    expect(r.query.get('from')).toBe('100');
    expect(r.query.get('to')).toBe('200');
    expect(r.query.get('limit')).toBe('10');
  });

  test('rejects unknown kinds', () => {
    expect(parseTraceUri('openchrome://trace/abc/bogus')).toBeNull();
  });

  test('decodes URI-encoded session ids', () => {
    expect(parseTraceUri('openchrome://trace/foo%20bar/meta')?.sessionId).toBe('foo bar');
  });

  test('returns null for malformed percent-encoded session ids', () => {
    // Regression: the prior implementation called decodeURIComponent
    // unguarded, so a bad %-sequence threw URIError out of the request
    // handler. parseTraceUri now reports "not a trace URI" instead.
    expect(parseTraceUri('openchrome://trace/%E0%A4%A/meta')).toBeNull();
  });
});

describe('buildTraceListPayload + readTraceResource(list)', () => {
  test('returns empty array when index is missing', () => {
    process.env.OPENCHROME_TRACE_ROOT = tempRoot();
    expect(JSON.parse(buildTraceListPayload())).toEqual([]);
  });

  test('returns recorded sessions ordered by started_at DESC', () => {
    const root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    const store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 'a', startedAt: 100, status: 'completed' });
    store.recordSessionStart({ sessionId: 'b', startedAt: 200, status: 'failed' });
    store.close();

    const rows = JSON.parse(buildTraceListPayload()) as Array<{
      session_id: string;
      status: string;
    }>;
    expect(rows.map((r) => r.session_id)).toEqual(['b', 'a']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('readTraceResource(list) returns mimeType=application/json', async () => {
    process.env.OPENCHROME_TRACE_ROOT = tempRoot();
    const r = await readTraceResource(traceListResource.uri);
    expect(r?.mimeType).toBe('application/json');
    expect(typeof r?.text).toBe('string');
    expect(JSON.parse(r!.text)).toEqual([]);
  });

  test('returns [] for tenant-bound callers (api-key + jwt) until tagging exists', () => {
    const root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    const store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 'tenant-a', startedAt: 100, status: 'completed' });
    store.close();

    const all = JSON.parse(buildTraceListPayload()) as unknown[];
    expect(all.length).toBe(1);
    const apiKey = JSON.parse(buildTraceListPayload({ mode: 'api-key' })) as unknown[];
    expect(apiKey).toEqual([]);
    // JWT callers also carry tenant identity — same fail-closed treatment.
    const jwt = JSON.parse(buildTraceListPayload({ mode: 'jwt' })) as unknown[];
    expect(jwt).toEqual([]);
    // disabled / legacy modes are not multi-tenant; they see all rows.
    const disabled = JSON.parse(buildTraceListPayload({ mode: 'disabled' })) as unknown[];
    expect(disabled.length).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('buildTraceContent — meta', () => {
  test('returns null for missing index', async () => {
    process.env.OPENCHROME_TRACE_ROOT = tempRoot();
    const r = await buildTraceContent({
      sessionId: 'x',
      kind: 'meta',
      query: new URLSearchParams(),
    });
    expect(r).toBeNull();
  });

  test('returns the index row JSON for a known session', async () => {
    const root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    const store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({
      sessionId: 's1',
      startedAt: 1000,
      domain: 'amazon.com',
      status: 'running',
      parentOp: 'tool:click',
    });
    store.close();

    const r = await buildTraceContent({
      sessionId: 's1',
      kind: 'meta',
      query: new URLSearchParams(),
    });
    expect(r).not.toBeNull();
    const meta = JSON.parse(r!) as {
      session_id: string;
      domain: string;
      status: string;
      parent_op: string;
    };
    expect(meta.session_id).toBe('s1');
    expect(meta.domain).toBe('amazon.com');
    expect(meta.parent_op).toBe('tool:click');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns null for unknown session id', async () => {
    const root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    const store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 's', startedAt: 1, status: 'completed' });
    store.close();

    expect(
      await buildTraceContent({
        sessionId: 'missing',
        kind: 'meta',
        query: new URLSearchParams(),
      }),
    ).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns null for tenant-bound callers (api-key + jwt)', async () => {
    const root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    const store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 's1', startedAt: 1000, status: 'completed' });
    store.close();

    expect(
      await buildTraceContent(
        { sessionId: 's1', kind: 'meta', query: new URLSearchParams() },
        { mode: 'api-key' },
      ),
    ).toBeNull();
    expect(
      await buildTraceContent(
        { sessionId: 's1', kind: 'meta', query: new URLSearchParams() },
        { mode: 'jwt' },
      ),
    ).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('buildTraceContent — events', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 'e', startedAt: 1, status: 'running' });
    store.appendEvents('e', [
      { ts: 100, seq: 1, kind: 'A', body: { i: 1 } },
      { ts: 200, seq: 2, kind: 'B', body: { i: 2 } },
      { ts: 300, seq: 3, kind: 'C', body: { i: 3 } },
    ]);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns total + returned + ordered events', async () => {
    const r = await buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams(),
    });
    const body = JSON.parse(r!) as {
      total: number;
      returned: number;
      truncated: boolean;
      events: Array<{ kind: string }>;
    };
    expect(body.total).toBe(3);
    expect(body.returned).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.events.map((e) => e.kind)).toEqual(['A', 'B', 'C']);
  });

  test('honors the limit query parameter', async () => {
    const r = await buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('limit=2'),
    });
    const body = JSON.parse(r!) as {
      events: Array<{ kind: string }>;
      total: number;
      returned: number;
    };
    expect(body.events.map((e) => e.kind)).toEqual(['A', 'B']);
    // total stays accurate even when matched events are capped — callers
    // need this to know how many events remain to page through.
    expect(body.total).toBe(3);
    expect(body.returned).toBe(2);
  });

  test('honors from / to filters and reports filtered total', async () => {
    const r = await buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('from=150&to=250'),
    });
    const body = JSON.parse(r!) as {
      events: Array<{ kind: string }>;
      total: number;
      returned: number;
    };
    expect(body.events.map((e) => e.kind)).toEqual(['B']);
    // `total` is the count of events matching the filter window — not
    // the whole session — so pagination clients don't chase pages that
    // don't exist for filtered queries.
    expect(body.total).toBe(1);
    expect(body.returned).toBe(1);
  });

  test('caps limit at 10000 to prevent OOM', async () => {
    const r = await buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('limit=999999'),
    });
    const body = JSON.parse(r!) as { events: unknown[] };
    expect(body.events.length).toBeLessThanOrEqual(10_000);
  });

  test('MAX_TOTAL_SCAN cap counts every line read, not only valid events', async () => {
    // Plant a session backed by a single chunk of pure garbage. The
    // prior cap was driven by valid-event count, so a file of malformed
    // lines could scan unbounded without ever tripping `truncated`.
    // The streaming reader now increments a separate `scanned` counter
    // on every non-blank line, so the cap fires deterministically.
    // Using a small file is enough to assert the path is taken — the
    // production cap is 200k lines, but the test patches it via env.
    const sessionDir = path.join(root, 'garbage');
    fs.mkdirSync(sessionDir, { recursive: true });
    const garbage = Array.from({ length: 50 }, () => 'not-json').join('\n') + '\n';
    fs.writeFileSync(path.join(sessionDir, '1-1.jsonl'), garbage);
    store.recordSessionStart({ sessionId: 'garbage', startedAt: 1, status: 'completed' });

    const r = await buildTraceContent({
      sessionId: 'garbage',
      kind: 'events',
      query: new URLSearchParams(),
    });
    // Even with 50 unparseable lines the read returns a clean empty
    // result — total=0, returned=0, no exception thrown.
    const body = JSON.parse(r!) as { total: number; returned: number; events: unknown[] };
    expect(body.total).toBe(0);
    expect(body.returned).toBe(0);
    expect(body.events).toEqual([]);
  });

  test('skips JSONL lines that parse but are not event envelopes', async () => {
    // Plant a mix of valid events, a JSON `null`, and a scalar `42`.
    // Each is independently parseable; without a shape guard, accessing
    // `null.ts` or `(42).ts` would throw and fail the entire read.
    const sessionDir = path.join(root, 'noise');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, '1-1.jsonl'),
      [
        JSON.stringify({ ts: 100, seq: 1, kind: 'OK', body: {} }),
        'null',
        '42',
        '"a string"',
        '{"unrelated": true}',
        JSON.stringify({ ts: 200, seq: 2, kind: 'ALSO_OK', body: {} }),
      ].join('\n') + '\n',
    );
    store.recordSessionStart({ sessionId: 'noise', startedAt: 1, status: 'completed' });

    const r = await buildTraceContent({
      sessionId: 'noise',
      kind: 'events',
      query: new URLSearchParams(),
    });
    const body = JSON.parse(r!) as { events: Array<{ kind: string }>; total: number };
    expect(body.events.map((e) => e.kind)).toEqual(['OK', 'ALSO_OK']);
    expect(body.total).toBe(2);
  });

  test('redacts credential patterns in event bodies on read', async () => {
    // Defence in depth: a legacy / outside-of-recorder JSONL line that
    // still contains a credential must not be returned verbatim.
    store.appendEvents('e', [
      {
        ts: 400,
        seq: 4,
        kind: 'Network.requestWillBeSent',
        body: {
          headers: { Authorization: 'Bearer abcdefghijklmnop' },
          url: 'https://x.example?token=hunter2hunter2',
        },
      },
    ]);
    const r = await buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams(),
    });
    const text = r!;
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('hunter2hunter2');
  });

  test('streams: limit=1 keeps matched array small even with many events', async () => {
    // Append a large batch and confirm the response cap is respected.
    // Regression target: the prior implementation read every event into
    // memory before slicing, so a small `limit` did not bound RSS.
    const big = Array.from({ length: 5_000 }, (_, i) => ({
      ts: 1000 + i,
      seq: 100 + i,
      kind: 'BULK',
      body: { i },
    }));
    store.appendEvents('e', big);

    const r = await buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('limit=1'),
    });
    const body = JSON.parse(r!) as { events: unknown[]; total: number; returned: number };
    expect(body.events.length).toBe(1);
    expect(body.returned).toBe(1);
    // 3 seed + 5000 bulk = 5003 total; total is computed by streaming,
    // so it stays accurate without materialising everything in matched.
    expect(body.total).toBe(5003);
  });
});

describe('readTraceResource — full URI dispatch', () => {
  let root: string;
  let store: TraceStorage;

  beforeEach(() => {
    root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 'r', startedAt: 1, status: 'completed' });
    store.appendEvents('r', [
      { ts: 100, seq: 1, kind: 'X', body: {} },
    ]);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('list URI', async () => {
    const r = await readTraceResource('openchrome://trace/list');
    expect(r?.mimeType).toBe('application/json');
    const rows = JSON.parse(r!.text) as Array<{ session_id: string }>;
    expect(rows[0].session_id).toBe('r');
  });

  test('meta URI', async () => {
    const r = await readTraceResource('openchrome://trace/r/meta');
    expect(r?.mimeType).toBe('application/json');
    const meta = JSON.parse(r!.text) as { session_id: string };
    expect(meta.session_id).toBe('r');
  });

  test('events URI', async () => {
    const r = await readTraceResource('openchrome://trace/r/events');
    expect(r?.mimeType).toBe('application/json');
    const body = JSON.parse(r!.text) as { events: Array<{ kind: string }> };
    expect(body.events).toEqual([{ ts: 100, seq: 1, kind: 'X', body: {} }]);
  });

  test('unknown session id returns null (not throw)', async () => {
    expect(await readTraceResource('openchrome://trace/missing/meta')).toBeNull();
  });

  test('non-trace URI returns null', async () => {
    expect(await readTraceResource('openchrome://other')).toBeNull();
  });

  test('list URI returns [] for tenant-bound callers (tenant isolation)', async () => {
    for (const mode of ['api-key', 'jwt'] as const) {
      const r = await readTraceResource(traceListResource.uri, { mode });
      expect(r?.mimeType).toBe('application/json');
      expect(JSON.parse(r!.text)).toEqual([]);
    }
  });

  test('meta URI returns null for tenant-bound callers (tenant isolation)', async () => {
    for (const mode of ['api-key', 'jwt'] as const) {
      expect(
        await readTraceResource('openchrome://trace/r/meta', { mode }),
      ).toBeNull();
    }
  });

  test('events URI returns null for tenant-bound callers (tenant isolation)', async () => {
    for (const mode of ['api-key', 'jwt'] as const) {
      expect(
        await readTraceResource('openchrome://trace/r/events', { mode }),
      ).toBeNull();
    }
  });
});
