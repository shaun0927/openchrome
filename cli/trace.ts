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
import * as readline from 'readline';

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

function fmtBytes(n: number | null | undefined): string {
  // Defensive: byte_size is INTEGER NOT NULL DEFAULT 0 in the schema, but
  // older trace indexes may have NULL rows, and `Math.log(0)` = -Infinity
  // would propagate to "NaN undefined". Treat any non-positive / non-finite
  // input as zero so `oc trace list` never renders garbage for empty traces.
  if (n == null || !Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)));
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

    // Header. The SESSION column is sized to the widest id in this batch
    // (with a 22-char floor for the header label) so the printed id can
    // always be copy-pasted into `oc trace show <id>`. UUIDs (36) and
    // longer ids stay intact.
    const cols = ['SESSION', 'STARTED', 'ENDED', 'STATUS', 'DOMAIN', 'SIZE'];
    const sessionWidth = rows.reduce(
      (acc, r) => Math.max(acc, (r.session_id || '').length),
      'SESSION'.length,
    );
    const widths = [sessionWidth, 19, 19, 10, 24, 10];
    console.log(cols.map((c, i) => c.padEnd(widths[i])).join(' '));
    console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, -1)));
    for (const r of rows) {
      console.log(
        [
          (r.session_id || '').padEnd(widths[0]),
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

/**
 * Stream every JSONL chunk for the session line-by-line and keep only
 * the last `limit` parseable events in memory. Counting `total` is
 * decoupled from the kept array, so memory stays bounded by `limit`
 * regardless of how large the trace directory has grown.
 *
 * Recorder names chunks `<ts>-<seq>.jsonl`. A plain lexical sort would
 * place `...-10.jsonl` before `...-2.jsonl`, and because recorder
 * timestamps come from `Date.now()` two flushes can share a millisecond,
 * so sort numerically by parsed `(ts, seq)`.
 */
async function streamSessionTail(
  sessionDir: string,
  limit: number,
): Promise<{ tail: JsonlEvent[]; total: number }> {
  const tail: JsonlEvent[] = [];
  let total = 0;
  if (!fs.existsSync(sessionDir)) return { tail, total };

  const files = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const m = /^(\d+)-(\d+)\.jsonl$/.exec(f);
      return { f, ts: m ? Number(m[1]) : 0, seq: m ? Number(m[2]) : 0 };
    })
    .sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq))
    .map((e) => e.f);

  for (const f of files) {
    const stream = fs.createReadStream(path.join(sessionDir, f), { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let parsed: JsonlEvent;
        try {
          parsed = JSON.parse(line) as JsonlEvent;
        } catch {
          continue;
        }
        total += 1;
        tail.push(parsed);
        // Bound the kept array to `limit` events. Shift drops the oldest
        // — the array is therefore always the most recent `limit` rows.
        if (tail.length > limit) tail.shift();
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  return { tail, total };
}

async function showTrace(sessionId: string, opts: { limit?: string; json?: boolean }): Promise<void> {
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

  const limit = Math.max(1, Math.min(10000, parseInt(opts.limit ?? '50', 10) || 50));
  // The CLI help advertises "recent events". Stream chunks and keep
  // only the trailing `limit` rows so memory stays O(limit) instead of
  // O(total trace size) — the prior implementation read every chunk in
  // full and only sliced at the end, which OOM'd on long sessions.
  const { tail: slice, total: totalEvents } = await streamSessionTail(
    path.join(rootDir, sessionId),
    limit,
  );
  const omitted = Math.max(0, totalEvents - slice.length);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { meta: row, events: slice, totalEvents, omitted },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Session  : ${row.session_id}`);
  console.log(`Started  : ${fmtTime(row.started_at)}`);
  console.log(`Ended    : ${fmtTime(row.ended_at)}`);
  console.log(`Status   : ${row.status}`);
  console.log(`Domain   : ${row.domain ?? '—'}`);
  console.log(`Parent op: ${row.parent_op ?? '—'}`);
  console.log(`Size     : ${fmtBytes(row.byte_size)}`);
  console.log(`Events   : ${totalEvents} (showing last ${slice.length})`);
  console.log('');
  if (omitted > 0) {
    console.log(`... (${omitted} earlier events; pass --limit to see more)`);
  }
  for (const ev of slice) {
    const t = fmtTime(ev.ts);
    const seq = String(ev.seq).padStart(4);
    console.log(`[${t}] #${seq} ${ev.kind}`);
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
    .action(async (sessionId: string, options: { limit?: string; json?: boolean }) => {
      await showTrace(sessionId, options);
    });
}
