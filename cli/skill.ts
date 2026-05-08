/**
 * `oc skill` subcommand group.
 *
 * Reads per-domain skill graph databases at
 * `~/.openchrome/skills/<domain>.db` and prints a summary. Mirrors the
 * `inspect()` API in `src/skill/storage.ts`, but speaks SQL directly so
 * we don't have to thread imports across the cli/ ↔ src/ boundary.
 *
 * Commands:
 *   oc skill inspect <domain> [--json]
 *   oc skill list                   (lists all domain DBs in the root)
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

const DEFAULT_SKILL_ROOT = path.join(os.homedir(), '.openchrome', 'skills');

function skillRoot(): string {
  return process.env.OPENCHROME_SKILL_ROOT ?? DEFAULT_SKILL_ROOT;
}

/**
 * Validate a domain argument before joining it into a filesystem path.
 *
 * Mirrors `SkillGraphStorage`'s constructor check (src/skill/storage.ts):
 * empty strings, path separators, and `..` segments are rejected so that
 * `<domain>.db` cannot escape `OPENCHROME_SKILL_ROOT`. Without this guard
 * a value like `../../other/place/foo` would let the CLI read arbitrary
 * `.db` files reachable from the current user.
 */
function assertSafeDomain(domain: string): void {
  if (!domain || /[\\/]/.test(domain) || domain === '..' || domain === '.') {
    throw new Error(`Invalid domain: ${JSON.stringify(domain)}`);
  }
}

function openDomainDb(rootDir: string, domain: string): Database | null {
  // The first call validates the user-provided domain — a separator or
  // `..` segment throws before the join below, so this `path.join` can
  // never escape `OPENCHROME_SKILL_ROOT`.
  assertSafeDomain(domain);
  const dbPath = path.join(rootDir, `${domain}.db`);
  if (!fs.existsSync(dbPath)) return null;
  const Sqlite = loadSqlite();
  return new Sqlite(dbPath, { readonly: true, fileMustExist: true });
}

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

interface InspectSummary {
  domain: string;
  nodeCount: number;
  edgeCount: number;
  topEdges: Array<{
    from: string;
    actionKind: string;
    successCount: number;
    failCount: number;
  }>;
  recentFailures: Array<{
    from: string;
    actionKind: string;
    failCount: number;
    lastFailedAt: number;
  }>;
}

function inspectDomain(domain: string, opts: { json?: boolean }): void {
  const rootDir = skillRoot();
  const db = openDomainDb(rootDir, domain);
  if (!db) {
    console.error(`No skill graph for domain: ${domain} (looked at ${rootDir}/${domain}.db)`);
    process.exitCode = 1;
    return;
  }

  let summary: InspectSummary;
  try {
    const nodeCount = (db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n;
    const edgeCount = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;
    const topRows = db
      .prepare(
        'SELECT from_state, action_kind, success_count, fail_count FROM edges ORDER BY success_count + fail_count DESC LIMIT 10',
      )
      .all() as Array<{
      from_state: string;
      action_kind: string;
      success_count: number;
      fail_count: number;
    }>;
    const failingRows = db
      .prepare(
        'SELECT from_state, action_kind, fail_count, last_failed_at FROM edges WHERE last_failed_at IS NOT NULL ORDER BY last_failed_at DESC LIMIT 10',
      )
      .all() as Array<{
      from_state: string;
      action_kind: string;
      fail_count: number;
      last_failed_at: number;
    }>;
    summary = {
      domain,
      nodeCount,
      edgeCount,
      topEdges: topRows.map((r) => ({
        from: r.from_state,
        actionKind: r.action_kind,
        successCount: r.success_count,
        failCount: r.fail_count,
      })),
      recentFailures: failingRows.map((r) => ({
        from: r.from_state,
        actionKind: r.action_kind,
        failCount: r.fail_count,
        lastFailedAt: r.last_failed_at,
      })),
    };
  } finally {
    db.close();
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Skill graph: ${summary.domain}`);
  console.log(`Nodes      : ${summary.nodeCount}`);
  console.log(`Edges      : ${summary.edgeCount}`);
  console.log('');
  console.log('Top edges by total invocations:');
  if (summary.topEdges.length === 0) {
    console.log('  (none)');
  } else {
    for (const e of summary.topEdges) {
      const total = e.successCount + e.failCount;
      const rate = total === 0 ? '—' : `${Math.round((e.successCount / total) * 100)}%`;
      console.log(
        `  ${e.from.slice(0, 16)}  ${e.actionKind.padEnd(12)}  ${String(e.successCount).padStart(4)} ok / ${String(e.failCount).padStart(4)} fail  (${rate})`,
      );
    }
  }
  console.log('');
  console.log('Recent failures:');
  if (summary.recentFailures.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of summary.recentFailures) {
      console.log(
        `  ${fmtTime(f.lastFailedAt)}  ${f.from.slice(0, 16)}  ${f.actionKind.padEnd(12)}  fail_count=${f.failCount}`,
      );
    }
  }
}

function listDomains(opts: { json?: boolean }): void {
  const rootDir = skillRoot();
  if (!fs.existsSync(rootDir)) {
    console.error(`No skill root at ${rootDir} — has the executor ever run?`);
    process.exitCode = 1;
    return;
  }
  const entries = fs.readdirSync(rootDir).filter((f) => f.endsWith('.db'));
  const domains = entries.map((f) => f.replace(/\.db$/, ''));
  if (opts.json) {
    console.log(JSON.stringify(domains, null, 2));
    return;
  }
  if (domains.length === 0) {
    console.error('No domain databases yet.');
    return;
  }
  for (const d of domains) console.log(d);
}

export function registerSkillCommand(program: Command): void {
  const cmd = program.command('skill').description('Inspect the skill-graph state');

  cmd
    .command('list')
    .description('List domains with a skill graph')
    .option('--json', 'Emit raw JSON instead of newline-separated names')
    .action((options: { json?: boolean }) => listDomains(options));

  cmd
    .command('inspect')
    .description('Show node/edge counts and top edges for a domain')
    .argument('<domain>', 'eTLD+1 host (matches the domain stored by the executor)')
    .option('--json', 'Emit raw JSON instead of pretty text')
    .action((domain: string, options: { json?: boolean }) => inspectDomain(domain, options));
}
