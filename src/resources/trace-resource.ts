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
 *
 * Tenant isolation
 * ----------------
 * The `traces` index does not yet carry a tenant id (the recorder writes
 * untagged rows; see #698 / #704). Until per-trace tenant tagging lands,
 * every read entry point refuses any caller that carries tenant identity
 * — i.e. `mode: 'api-key'` and `mode: 'jwt'` — because both authenticate
 * a specific tenant in multi-tenant deployments and would otherwise be
 * able to enumerate other tenants' sessions. `list` returns `[]` and
 * dynamic URIs return null for those callers. `disabled` / `legacy` /
 * stdio (no principal) are unaffected. This is fail-closed.
 *
 * Defense in depth on read
 * ------------------------
 * The recorder runs the redactor on the write path (#735 / #736), but
 * trace files written before a redactor pattern existed, written by
 * tooling outside the recorder, or written by a buggy producer can
 * still contain credentials. Every event returned through this module
 * is therefore re-redacted before serialization — the cost is one
 * pattern pass against already-stored JSONL and the redactor module is
 * the same one the writer uses, so behaviour stays consistent.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { redactTraceEvent } from '../trace/redactor';
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

/**
 * Caller identity carried into the resource read paths. Mirrors the
 * shape of `Principal` in src/auth/api-key-types.ts but is declared
 * structurally to keep this module free of an auth import.
 */
export interface TraceResourceCaller {
  mode?: string;
  tenantId?: string;
}

/**
 * True when the caller carries a tenant identity that we cannot honour
 * at read time yet — i.e. `api-key` or `jwt` modes. Both authenticate
 * a specific tenant, so serving the un-tagged `traces` table to either
 * would leak cross-tenant data. Returns false for stdio (no principal)
 * and for `disabled` / `legacy` modes which are not multi-tenant.
 */
function isTenantBoundCaller(caller?: TraceResourceCaller): boolean {
  if (!caller || !caller.mode) return false;
  return caller.mode === 'api-key' || caller.mode === 'jwt';
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
export function buildTraceListPayload(caller?: TraceResourceCaller): string {
  // Fail-closed for tenant-bound callers — see file header on isolation.
  if (isTenantBoundCaller(caller)) return JSON.stringify([]);
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
  let u: URL;
  try {
    u = new URL(uri.replace('openchrome://', 'http://oc/'));
  } catch {
    return null;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  // segments: ['trace', '<id>', '<meta|events>']
  if (segments.length !== 3 || segments[0] !== 'trace') return null;
  const kind = segments[2];
  if (kind !== 'meta' && kind !== 'events') return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
  return { sessionId, kind, query: u.searchParams };
}

interface TraceEventEnvelope {
  ts: number;
  seq: number;
  kind: string;
  body: unknown;
}

interface StreamReadResult {
  total: number;
  matched: TraceEventEnvelope[];
  truncated: boolean;
}

/**
 * Stream every JSONL file for the session and apply `from`/`to`/`limit`
 * filters inline. Stops materialising into the result array once `limit`
 * matches have been collected, but continues counting lines so `total`
 * stays accurate for the caller. A hard `MAX_TOTAL_SCAN` cap protects
 * the read path from a runaway file: when it trips the response is
 * marked `truncated: true` so callers can paginate forward.
 */
async function streamSessionEvents(
  sessionId: string,
  filters: { from?: number; to?: number; limit: number },
): Promise<StreamReadResult> {
  const sessionDir = path.join(traceRoot(), sessionId);
  if (!fs.existsSync(sessionDir)) {
    return { total: 0, matched: [], truncated: false };
  }
  const files = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();

  const matched: TraceEventEnvelope[] = [];
  let total = 0;
  let truncated = false;

  outer: for (const f of files) {
    const stream = fs.createReadStream(path.join(sessionDir, f), {
      encoding: 'utf8',
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        if (total >= MAX_TOTAL_SCAN) {
          truncated = true;
          break outer;
        }
        let parsed: TraceEventEnvelope | null = null;
        try {
          parsed = JSON.parse(line) as TraceEventEnvelope;
        } catch {
          // skip malformed; do not increment total — total counts only
          // well-formed events so callers can page consistently.
          continue;
        }
        total += 1;
        if (filters.from !== undefined && parsed.ts < filters.from) continue;
        if (filters.to !== undefined && parsed.ts > filters.to) continue;
        if (matched.length < filters.limit) matched.push(parsed);
        // Important: do NOT break here — `total` must reflect every
        // matching event so the caller knows how much paging remains.
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  return { total, matched, truncated };
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
 * Hard cap on lines scanned per read. Bounds memory and wall time even
 * if the JSONL backing files are unbounded. 200k events ≈ a few MB of
 * working set when matched.length stays ≤ MAX_EVENT_LIMIT.
 */
const MAX_TOTAL_SCAN = 200_000;

/**
 * Compute the JSON payload for a parsed dynamic URI. Returns null when
 * the underlying session is not found in the index, or when the caller
 * is tenant-bound (api-key / jwt) — fail-closed pending per-trace tenant
 * tagging; see file header.
 */
export async function buildTraceContent(
  parsed: ResolvedTraceUri,
  caller?: TraceResourceCaller,
): Promise<string | null> {
  if (isTenantBoundCaller(caller)) return null;
  const db = openIndex();
  if (!db) return null;
  let meta: unknown;
  try {
    meta = db
      .prepare(
        'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces WHERE session_id = ?',
      )
      .get(parsed.sessionId);
  } finally {
    db.close();
  }
  if (!meta) return null;
  if (parsed.kind === 'meta') return JSON.stringify(meta);

  const fromTs = numericQuery(parsed.query, 'from');
  const toTs = numericQuery(parsed.query, 'to');
  const limit = Math.max(
    1,
    Math.min(MAX_EVENT_LIMIT, numericQuery(parsed.query, 'limit') ?? DEFAULT_EVENT_LIMIT),
  );

  const result = await streamSessionEvents(parsed.sessionId, {
    from: fromTs,
    to: toTs,
    limit,
  });

  // Defence in depth: re-run the redactor over every returned event so
  // a legacy / outside-of-recorder JSONL line cannot leak credentials
  // through the read path. Same module the recorder uses on write, so
  // patterns stay aligned.
  const redacted = result.matched.map((ev) => redactTraceEvent(ev));

  return JSON.stringify({
    sessionId: parsed.sessionId,
    total: result.total,
    returned: redacted.length,
    truncated: result.truncated,
    events: redacted,
  });
}

/** Combined entry point used by the prefix handler in MCPServer. */
export async function readTraceResource(
  uri: string,
  caller?: TraceResourceCaller,
): Promise<{ mimeType: string; text: string } | null> {
  if (uri === traceListResource.uri) {
    return {
      mimeType: traceListResource.mimeType,
      text: buildTraceListPayload(caller),
    };
  }
  const parsed = parseTraceUri(uri);
  if (!parsed) return null;
  const text = await buildTraceContent(parsed, caller);
  if (text === null) return null;
  return { mimeType: 'application/json', text };
}
