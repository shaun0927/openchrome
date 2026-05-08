/**
 * Tiny HTTP server backing `oc trace play`.
 *
 * Binds to 127.0.0.1 only (no external exposure). Default port is
 * ephemeral (resolved by the OS); override with `OPENCHROME_REPLAY_PORT`
 * for deterministic dev setups. The actual port is printed to stdout
 * after the listen() callback fires so callers can detect it.
 *
 * Endpoints:
 *   GET /                     → served from assets/replay/index.html
 *   GET /api/trace/list       → JSON array (latest 50 traces)
 *   GET /api/trace/<id>/meta  → JSON metadata for one trace
 *   GET /api/trace/<id>/events?from=<ts>&to=<ts>&limit=<n>
 *                             → JSON event slice
 *
 * The server reads the same `~/.openchrome/traces/index.sqlite` and
 * per-session JSONL files written by `src/trace/recorder.ts`.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

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

function staticAssetPath(): string {
  // dist/cli/replay-server.js → assets/replay/index.html
  // src cli/replay-server.ts → assets/replay/index.html (during ts-node)
  const candidates = [
    path.resolve(__dirname, '..', '..', 'assets', 'replay', 'index.html'),
    path.resolve(__dirname, '..', 'assets', 'replay', 'index.html'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function readSessionEvents(rootDir: string, sessionId: string): unknown[] {
  const sessionDir = path.join(rootDir, sessionId);
  if (!fs.existsSync(sessionDir)) return [];
  const out: unknown[] = [];
  const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const f of files) {
    const content = fs.readFileSync(path.join(sessionDir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return out;
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function send404(res: http.ServerResponse): void {
  send(res, 404, { error: 'not_found' });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Top-level guard so a malformed URL (URIError from new URL or
  // decodeURIComponent on a bad percent-encoded segment) cannot escape
  // and terminate the listener — that would let one bad local request
  // DoS the replay server until restart.
  try {
    handleRequestInner(req, res);
  } catch (err) {
    if (err instanceof URIError) {
      send(res, 400, { error: 'bad_request', detail: 'malformed URI' });
      return;
    }
    console.error('[replay] request handler crashed:', err);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
}

function handleRequestInner(req: http.IncomingMessage, res: http.ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad_request', detail: 'malformed URL' });
  }
  const rootDir = traceRoot();

  // Static index
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const assetPath = staticAssetPath();
    if (!fs.existsSync(assetPath)) {
      return send(res, 500, '<h1>Replay UI assets missing</h1><p>Expected at assets/replay/index.html</p>', 'text/html');
    }
    return send(res, 200, fs.readFileSync(assetPath), 'text/html; charset=utf-8');
  }

  // Trace list
  if (req.method === 'GET' && url.pathname === '/api/trace/list') {
    let db: Database;
    try {
      const Sqlite = loadSqlite();
      db = new Sqlite(path.join(rootDir, 'index.sqlite'), { readonly: true, fileMustExist: true });
    } catch {
      return send(res, 200, []);
    }
    try {
      const rows = db
        .prepare(
          'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces ORDER BY started_at DESC LIMIT 50',
        )
        .all();
      return send(res, 200, rows);
    } finally {
      db.close();
    }
  }

  // Trace meta + events
  const traceMatch = /^\/api\/trace\/([^/]+)\/(meta|events)$/.exec(url.pathname);
  if (req.method === 'GET' && traceMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(traceMatch[1]);
    } catch {
      return send(res, 400, { error: 'bad_request', detail: 'malformed session id' });
    }
    const which = traceMatch[2];
    let db: Database;
    try {
      const Sqlite = loadSqlite();
      db = new Sqlite(path.join(rootDir, 'index.sqlite'), { readonly: true, fileMustExist: true });
    } catch {
      return send404(res);
    }
    try {
      const meta = db
        .prepare(
          'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces WHERE session_id = ?',
        )
        .get(sessionId);
      if (!meta) return send404(res);
      if (which === 'meta') return send(res, 200, meta);

      const events = readSessionEvents(rootDir, sessionId);
      const fromTs = numberQueryParam(url, 'from');
      const toTs = numberQueryParam(url, 'to');
      const limit = Math.max(1, Math.min(10000, numberQueryParam(url, 'limit') ?? 1000));
      let filtered = events as Array<{ ts: number }>;
      if (fromTs !== undefined) filtered = filtered.filter((e) => e.ts >= fromTs);
      if (toTs !== undefined) filtered = filtered.filter((e) => e.ts <= toTs);
      const slice = filtered.slice(0, limit);
      return send(res, 200, { sessionId, total: events.length, returned: slice.length, events: slice });
    } finally {
      db.close();
    }
  }

  send404(res);
}

function numberQueryParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export interface ReplayServerHandle {
  /** Concrete port the server bound to. */
  port: number;
  /** URL to print to stdout / open in a browser. */
  url: string;
  /** Closes the listener. Resolves once close(callback) settles. */
  close(): Promise<void>;
}

/**
 * Start the replay HTTP server. Returns once it is listening on the
 * resolved port. Default: 127.0.0.1:0 (ephemeral); override with
 * `OPENCHROME_REPLAY_PORT` or the `port` option.
 */
export async function startReplayServer(opts: { port?: number } = {}): Promise<ReplayServerHandle> {
  const desiredPort =
    opts.port ?? (process.env.OPENCHROME_REPLAY_PORT ? Number(process.env.OPENCHROME_REPLAY_PORT) : 0);
  const server = http.createServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(desiredPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}/`;
  return {
    port,
    url,
    close: () => new Promise((res) => server.close(() => res())),
  };
}
