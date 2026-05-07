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
});

describe('buildTraceContent — meta', () => {
  test('returns null for missing index', () => {
    process.env.OPENCHROME_TRACE_ROOT = tempRoot();
    const r = buildTraceContent({
      sessionId: 'x',
      kind: 'meta',
      query: new URLSearchParams(),
    });
    expect(r).toBeNull();
  });

  test('returns the index row JSON for a known session', () => {
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

    const r = buildTraceContent({
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

  test('returns null for unknown session id', () => {
    const root = tempRoot();
    process.env.OPENCHROME_TRACE_ROOT = root;
    const store = new TraceStorage({ rootDir: root });
    store.recordSessionStart({ sessionId: 's', startedAt: 1, status: 'completed' });
    store.close();

    expect(
      buildTraceContent({ sessionId: 'missing', kind: 'meta', query: new URLSearchParams() }),
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

  test('returns total + returned + ordered events', () => {
    const r = buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams(),
    });
    const body = JSON.parse(r!) as {
      total: number;
      returned: number;
      events: Array<{ kind: string }>;
    };
    expect(body.total).toBe(3);
    expect(body.returned).toBe(3);
    expect(body.events.map((e) => e.kind)).toEqual(['A', 'B', 'C']);
  });

  test('honors the limit query parameter', () => {
    const r = buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('limit=2'),
    });
    const body = JSON.parse(r!) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['A', 'B']);
  });

  test('honors from / to filters', () => {
    const r = buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('from=150&to=250'),
    });
    const body = JSON.parse(r!) as { events: Array<{ kind: string }> };
    expect(body.events.map((e) => e.kind)).toEqual(['B']);
  });

  test('caps limit at 10000 to prevent OOM', () => {
    const r = buildTraceContent({
      sessionId: 'e',
      kind: 'events',
      query: new URLSearchParams('limit=999999'),
    });
    const body = JSON.parse(r!) as { events: unknown[] };
    expect(body.events.length).toBeLessThanOrEqual(10_000);
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
});
