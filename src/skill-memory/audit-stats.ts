/**
 * Audit-log-backed `SkillStatsResolver` for the curator (#715).
 *
 * The curator (PR-22) is wire-shape agnostic — it accepts any function
 * that maps a `SkillRecord` to `SkillRunStats`. This module ships the
 * canonical implementation: stream `~/.openchrome/audit.jsonl` line by
 * line, count contract_runtime verdicts that match the skill's
 * contract_ref, and surface success / failure totals + last-run-at.
 *
 * Streaming + lazy parse — the audit log can be hundreds of MB on
 * busy machines, so we never `JSON.parse` the whole file. Lines are
 * read via a tiny line-buffered reader, parsed individually, and
 * filtered against the window before any aggregation work.
 *
 * Demote-history fields (`demotesInDoubleDemoteWindow`,
 * `hadInterveningPromotion`) are NOT in the audit log — they live in
 * the curator's own actions.jsonl. PR-22 wrote that file path but
 * doesn't populate it yet; the simplest correct behavior is to
 * default both fields conservatively (0 + false) so the curator's
 * double-demote-archive path stays inactive until the history store
 * lands.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SkillRunStats, SkillStatsResolver } from './curator';
import type { SkillRecord } from './types';

const DEFAULT_FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuditStatsResolverOptions {
  /** Path to the audit log JSONL. Default: ~/.openchrome/audit.jsonl. */
  auditLogPath?: string;
  /** Failure-rate window in ms. Default 30 days. */
  failWindowMs?: number;
  /** Test hook: clock for "now". */
  now?: () => number;
  /**
   * Override the line reader — tests inject in-memory streams; CLI
   * paths use the default fs-backed reader.
   */
  readLines?: (path: string) => Iterable<string>;
}

export function defaultAuditLogPath(): string {
  return path.join(os.homedir(), '.openchrome', 'audit.jsonl');
}

/**
 * Synchronous line-by-line iterator over a possibly-large file.
 * Reads in 64 KB chunks, splits on `\n`, yields complete lines.
 * Trailing partial line is yielded at EOF (after a final '\n' boundary).
 */
function* readLinesFromFile(filePath: string): Iterable<string> {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, 'r');
  const CHUNK = 64 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let leftover = '';
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const text = leftover + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      leftover = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    if (leftover.length > 0) yield leftover;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Match entries that came out of the contract runtime. The audit-log
 * extended schema (see src/security/audit-logger.ts) writes
 * `{ ts, tool, args, ... }`; the runtime sets `tool = 'contract_runtime'`
 * and spreads the entire TransactionRecord into `args` (the runtime
 * passed it through verbatim — see runtime.ts settle()).
 */
interface RuntimeAuditRow {
  ts?: string;
  tool?: string;
  args?: {
    contract_id?: string;
    contract_ref?: string;
    verdict?: string;
    started_at?: number;
    ended_at?: number;
  };
}

interface SkillRunAuditRow {
  ts?: string;
  tool?: string;
  args?: {
    skill_id?: string;
    contract_ref?: string;
    domain?: string;
    ts?: number;
  };
}

function parseTs(value: unknown): number | null {
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Build a SkillStatsResolver bound to a given audit-log path. Each
 * resolver call streams the file once — for repeated use across many
 * skills in a single curator run, callers should pass `cacheRows: true`
 * to avoid re-streaming the same file N times.
 */
export function createAuditLogStatsResolver(
  opts: AuditStatsResolverOptions = {},
): SkillStatsResolver {
  const auditLogPath = opts.auditLogPath ?? defaultAuditLogPath();
  const failWindowMs = opts.failWindowMs ?? DEFAULT_FAIL_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const readLines = opts.readLines ?? readLinesFromFile;

  return (record: SkillRecord): SkillRunStats => {
    const t = now();
    const cutoff = t - failWindowMs;
    const matchContract = record.sidecar.contract_id;
    const matchSkillId = record.skill_id;

    let successesInWindow = 0;
    let failuresInWindow = 0;
    let lastRunAt: number | null = null;

    for (const line of readLines(auditLogPath)) {
      if (!line.trim() || !line.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const entry = parsed as RuntimeAuditRow & SkillRunAuditRow;
      const ts = parseTs(entry.ts);
      if (ts === null || ts < cutoff) continue;

      // contract_runtime entries → success / failure tallies
      if (entry.tool === 'contract_runtime' && entry.args) {
        const cid = entry.args.contract_id;
        if (cid !== matchContract) continue;
        if (entry.args.verdict === 'success') successesInWindow++;
        else if (entry.args.verdict === 'postcondition_violation') failuresInWindow++;
      }

      // skill_run entries (deferred audit channel) → lastRunAt tracker
      if (entry.tool === 'skill_run' && entry.args) {
        if (entry.args.skill_id === matchSkillId) {
          if (lastRunAt === null || ts > lastRunAt) lastRunAt = ts;
        }
      }

      // contract_runtime success entries also update lastRunAt — same
      // contract → same skill — so the curator's "untouched" check is
      // not falsely triggered just because skill_run wiring is deferred.
      if (
        entry.tool === 'contract_runtime' &&
        entry.args?.contract_id === matchContract
      ) {
        if (lastRunAt === null || ts > lastRunAt) lastRunAt = ts;
      }
    }

    return {
      successesInWindow,
      failuresInWindow,
      lastRunAt,
      demotesInDoubleDemoteWindow: 0,
      hadInterveningPromotion: false,
    };
  };
}

/**
 * Convenience: build a stats resolver that reads each call from a
 * pre-loaded line array. Useful when the curator runs across many
 * skills and we want to amortize one file read across all of them.
 */
export function createInMemoryStatsResolver(
  lines: string[],
  opts: Omit<AuditStatsResolverOptions, 'readLines' | 'auditLogPath'> = {},
): SkillStatsResolver {
  return createAuditLogStatsResolver({
    ...opts,
    auditLogPath: '<in-memory>',
    readLines: () => lines,
  });
}
