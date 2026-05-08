/**
 * `oc trace` subcommand group.
 *
 * Reads the trace index at `~/.openchrome/traces/index.sqlite` and the
 * per-session JSONL files written by `src/trace/recorder.ts`. The CLI
 * does not import from `src/` because tsconfig.cli.json roots from
 * `cli/` — it speaks SQL directly against the trace index.
 *
 * Commands:
 *   oc trace list   [--since ISO|--status|--domain|--limit]
 *   oc trace show   <session-id> [--limit]
 *
 * `oc trace play` (interactive replay UI) is deferred to a follow-up PR.
 */

import type { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type BetterSqlite3 = typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;

let _Sqlite: BetterSqlite3 | null = null;
function loadSqlite(): BetterSqlite3 {
  if (_Sqlite) return _Sqlite;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _Sqlite = require('better-sqlite3') as BetterSqlite3;
  return _Sqlite;
}

interface TraceRow {
  session_id: string;
  started_at: number;
  ended_at: number | null;
  domain: string | null;
  status: string;
  byte_size: number;
  parent_op: string | null;
}

interface JsonlEvent {
  ts: number;
  seq: number;
  kind: string;
  body: unknown;
}

const DEFAULT_TRACE_ROOT = path.join(os.homedir(), '.openchrome', 'traces');

function traceRoot(): string {
  return process.env.OPENCHROME_TRACE_ROOT ?? DEFAULT_TRACE_ROOT;
}

function openIndex(rootDir: string): Database | null {
  const dbPath = path.join(rootDir, 'index.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  const Sqlite = loadSqlite();
  return new Sqlite(dbPath, { readonly: true, fileMustExist: true });
}

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${(n / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function listTraces(opts: {
  since?: string;
  status?: string;
  domain?: string;
  limit?: string;
  json?: boolean;
}): void {
  const rootDir = traceRoot();
  const db = openIndex(rootDir);
  if (!db) {
    console.error(`No trace index at ${rootDir}/index.sqlite — has the recorder ever run?`);
    process.exitCode = 1;
    return;
  }
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.since) {
      const t = Date.parse(opts.since);
      if (Number.isNaN(t)) {
        console.error(`Invalid --since: ${opts.since}`);
        process.exitCode = 1;
        return;
      }
      where.push('started_at >= ?');
      params.push(t);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.domain) {
      where.push('domain = ?');
      params.push(opts.domain);
    }
    const limit = Math.max(1, Math.min(1000, parseInt(opts.limit ?? '50', 10) || 50));
    const sql =
      'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY started_at DESC LIMIT ?';
    const rows = db.prepare(sql).all(...params, limit) as TraceRow[];

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.error('No traces matched the filter.');
      return;
    }

    // Header
    const cols = ['SESSION', 'STARTED', 'ENDED', 'STATUS', 'DOMAIN', 'SIZE'];
    const widths = [22, 19, 19, 10, 24, 10];
    console.log(cols.map((c, i) => c.padEnd(widths[i])).join(' '));
    console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, -1)));
    for (const r of rows) {
      console.log(
        [
          (r.session_id || '').slice(0, widths[0]).padEnd(widths[0]),
          fmtTime(r.started_at).padEnd(widths[1]),
          fmtTime(r.ended_at).padEnd(widths[2]),
          (r.status || '').padEnd(widths[3]),
          (r.domain ?? '').slice(0, widths[4]).padEnd(widths[4]),
          fmtBytes(r.byte_size).padEnd(widths[5]),
        ].join(' '),
      );
    }
  } finally {
    db.close();
  }
}

function showTrace(sessionId: string, opts: { limit?: string; json?: boolean }): void {
  const rootDir = traceRoot();
  const db = openIndex(rootDir);
  if (!db) {
    console.error(`No trace index at ${rootDir}/index.sqlite`);
    process.exitCode = 1;
    return;
  }
  let row: TraceRow | undefined;
  try {
    row = db
      .prepare(
        'SELECT session_id, started_at, ended_at, domain, status, byte_size, parent_op FROM traces WHERE session_id = ?',
      )
      .get(sessionId) as TraceRow | undefined;
  } finally {
    db.close();
  }
  if (!row) {
    console.error(`No trace found: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  // Read JSONL files for this session.
  const sessionDir = path.join(rootDir, sessionId);
  const events: JsonlEvent[] = [];
  if (fs.existsSync(sessionDir)) {
    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    for (const f of files) {
      const content = fs.readFileSync(path.join(sessionDir, f), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // skip malformed
        }
      }
    }
  }

  const limit = Math.max(1, Math.min(10000, parseInt(opts.limit ?? '50', 10) || 50));
  const slice = events.slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify({ meta: row, events: slice, totalEvents: events.length }, null, 2));
    return;
  }

  console.log(`Session  : ${row.session_id}`);
  console.log(`Started  : ${fmtTime(row.started_at)}`);
  console.log(`Ended    : ${fmtTime(row.ended_at)}`);
  console.log(`Status   : ${row.status}`);
  console.log(`Domain   : ${row.domain ?? '—'}`);
  console.log(`Parent op: ${row.parent_op ?? '—'}`);
  console.log(`Size     : ${fmtBytes(row.byte_size)}`);
  console.log(`Events   : ${events.length} (showing first ${slice.length})`);
  console.log('');
  for (const ev of slice) {
    const t = fmtTime(ev.ts);
    const seq = String(ev.seq).padStart(4);
    console.log(`[${t}] #${seq} ${ev.kind}`);
  }
  if (events.length > slice.length) {
    console.log(`... (${events.length - slice.length} more events; pass --limit to see more)`);
  }
}

export function registerTraceCommand(program: Command): void {
  const cmd = program.command('trace').description('Inspect captured browser-session traces');

  cmd
    .command('list')
    .description('List recent trace sessions')
    .option('--since <iso>', 'Only sessions started at or after this ISO timestamp')
    .option('--status <status>', 'Filter by status (running|completed|failed|aborted)')
    .option('--domain <domain>', 'Filter by exact domain match')
    .option('--limit <n>', 'Max rows to return (default 50, cap 1000)', '50')
    .option('--json', 'Emit raw JSON instead of table')
    .action((options: { since?: string; status?: string; domain?: string; limit?: string; json?: boolean }) =>
      listTraces(options),
    );

  cmd
    .command('show')
    .description('Show metadata + recent events for one trace session')
    .argument('<session-id>', 'The trace session id (from `oc trace list`)')
    .option('--limit <n>', 'Max events to print (default 50, cap 10000)', '50')
    .option('--json', 'Emit raw JSON instead of pretty text')
    .action((sessionId: string, options: { limit?: string; json?: boolean }) =>
      showTrace(sessionId, options),
    );

  cmd
    .command('play')
    .description('Open the local replay UI in a browser (127.0.0.1 only)')
    .option('--port <port>', 'Bind to a specific port (default: ephemeral, OPENCHROME_REPLAY_PORT honored)')
    .option('--no-open', 'Print the URL but do not auto-open the browser')
    .action(async (options: { port?: string; open?: boolean }) => {
      const { startReplayServer } = await import('./replay-server');
      const portNum = options.port ? Number.parseInt(options.port, 10) : undefined;
      const handle = await startReplayServer({ port: portNum });
      console.log(`Replay UI: ${handle.url}`);
      console.log('Press Ctrl-C to stop.');
      if (options.open !== false) {
        // Best-effort browser open. macOS / Linux / Windows.
        const cmd =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'start'
              : 'xdg-open';
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const cp = require('child_process');
          const child = cp.spawn(cmd, [handle.url], {
            detached: true,
            stdio: 'ignore',
            shell: process.platform === 'win32',
          });
          // `spawn` reports a missing launcher (e.g. xdg-open absent on a
          // minimal CI image) via an asynchronous 'error' event, not a
          // synchronous throw. Without a listener, the event would crash
          // the process — defeating the "best-effort" contract. Swallow it.
          child.on('error', () => undefined);
          child.unref();
        } catch {
          // Open is best-effort — user can copy the URL from stdout.
        }
      }
      // Keep the process alive on stdin close (Ctrl-C / parent exit).
      process.on('SIGINT', () => {
        void handle.close().then(() => process.exit(0));
      });
      process.on('SIGTERM', () => {
        void handle.close().then(() => process.exit(0));
      });
    });
}
