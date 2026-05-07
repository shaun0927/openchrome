/**
 * MCP resources for the trace subsystem.
 *
 * Exposes captured trace data via three URI shapes:
 *
 *   openchrome://trace/list            (static)
 *     → top-50 sessions as JSON {session_id, started_at, ended_at,
 *        domain, status, byte_size, parent_op}
 *
 *   openchrome://trace/<id>/meta       (dynamic)
 *     → one-row meta for the given session
 *
 *   openchrome://trace/<id>/events?from=&to=&limit=
 *     → JSON {sessionId, total, returned, events[]}
 *
 * The list URI is registered as a regular MCPResource so it shows up in
 * `resources/list`. The dynamic URIs are served via the prefix-handler
 * extension on MCPServer (registerResourcePrefix).
 *
 * Reads from `~/.openchrome/traces/index.sqlite` and the per-session
 * JSONL files. Read-only; no MCP write resources.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MCPResourceDefinition } from './usage-guide';

type BetterSqlite3 = typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;

let _Sqlite: BetterSqlite3 | null = null;
function loadSqlite(): BetterSqlite3 {
  if (_Sqlite) return _Sqlite;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _Sqlite = require('better-sqlite3') as BetterSqlite3;
  return _Sqlite;
}

const DEFAULT_TRACE_ROOT = path.join(os.homedir(), '.openchrome', 'traces');

function traceRoot(): string {
  return process.env.OPENCHROME_TRACE_ROOT ?? DEFAULT_TRACE_ROOT;
}

function openIndex(): Database | null {
  const dbPath = path.join(traceRoot(), 'index.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  const Sqlite = loadSqlite();
  return new Sqlite(dbPath, { readonly: true, fileMustExist: true });
}

/** Static-listing resource — discoverable via `resources/list`. */
export const traceListResource: MCPResourceDefinition = {
  uri: 'openchrome://trace/list',
  name: 'trace-list',
  description:
    'JSON: top-50 most recent trace sessions with metadata. Dynamic per-session URIs ' +
    'follow the pattern openchrome://trace/<sessionId>/meta and openchrome://trace/<sessionId>/events',
  mimeType: 'application/json',
};

/** Build the JSON payload for `openchrome://trace/list`. */
export function buildTraceListPayload(): string {
  const db = openIndex();
  if (!db) return JSON.stringify([]);
  try {
    const rows = db
      .prepare(
        'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces ORDER BY started_at DESC LIMIT 50',
      )
      .all();
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

interface ResolvedTraceUri {
  sessionId: string;
  kind: 'meta' | 'events';
  query: URLSearchParams;
}

/**
 * Parse `openchrome://trace/<id>/{meta|events}[?...]`. Returns null when
 * the URI is the static list (`openchrome://trace/list`) or any other
 * shape the trace handler does not own.
 */
export function parseTraceUri(uri: string): ResolvedTraceUri | null {
  if (!uri.startsWith('openchrome://trace/')) return null;
  if (uri === 'openchrome://trace/list') return null;
  // Use URL parser by substituting a host so query parsing works uniformly.
  const u = new URL(uri.replace('openchrome://', 'http://oc/'));
  const segments = u.pathname.split('/').filter(Boolean);
  // segments: ['trace', '<id>', '<meta|events>']
  if (segments.length !== 3 || segments[0] !== 'trace') return null;
  const kind = segments[2];
  if (kind !== 'meta' && kind !== 'events') return null;
  return {
    sessionId: decodeURIComponent(segments[1]),
    kind,
    query: u.searchParams,
  };
}

interface TraceEventEnvelope {
  ts: number;
  seq: number;
  kind: string;
  body: unknown;
}

function readSessionEvents(sessionId: string): TraceEventEnvelope[] {
  const sessionDir = path.join(traceRoot(), sessionId);
  if (!fs.existsSync(sessionDir)) return [];
  const out: TraceEventEnvelope[] = [];
  const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of files) {
    const content = fs.readFileSync(path.join(sessionDir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TraceEventEnvelope);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

function numericQuery(q: URLSearchParams, name: string): number | undefined {
  const raw = q.get(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Default `limit` for events (matches replay-server). */
const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 10_000;

/**
 * Compute the JSON payload for a parsed dynamic URI. Returns null when
 * the underlying session is not found in the index.
 */
export function buildTraceContent(parsed: ResolvedTraceUri): string | null {
  const db = openIndex();
  if (!db) return null;
  try {
    const meta = db
      .prepare(
        'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces WHERE session_id = ?',
      )
      .get(parsed.sessionId);
    if (!meta) return null;
    if (parsed.kind === 'meta') return JSON.stringify(meta);

    const events = readSessionEvents(parsed.sessionId);
    const fromTs = numericQuery(parsed.query, 'from');
    const toTs = numericQuery(parsed.query, 'to');
    const limit = Math.max(
      1,
      Math.min(MAX_EVENT_LIMIT, numericQuery(parsed.query, 'limit') ?? DEFAULT_EVENT_LIMIT),
    );
    let filtered = events;
    if (fromTs !== undefined) filtered = filtered.filter((e) => e.ts >= fromTs);
    if (toTs !== undefined) filtered = filtered.filter((e) => e.ts <= toTs);
    const slice = filtered.slice(0, limit);
    return JSON.stringify({
      sessionId: parsed.sessionId,
      total: events.length,
      returned: slice.length,
      events: slice,
    });
  } finally {
    db.close();
  }
}

/** Combined entry point used by the prefix handler in MCPServer. */
export async function readTraceResource(
  uri: string,
): Promise<{ mimeType: string; text: string } | null> {
  if (uri === traceListResource.uri) {
    return { mimeType: traceListResource.mimeType, text: buildTraceListPayload() };
  }
  const parsed = parseTraceUri(uri);
  if (!parsed) return null;
  const text = buildTraceContent(parsed);
  if (text === null) return null;
  return { mimeType: 'application/json', text };
}
