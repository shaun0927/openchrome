/**
 * Audit-log-backed `SkillStatsResolver` for the curator (#715).
 *
 * The curator (PR-22) is wire-shape agnostic — it accepts any function
 * that maps a `SkillRecord` to `SkillRunStats`. This module ships the
 * canonical implementation: stream `~/.openchrome/audit.log` line by
 * line, count contract_runtime verdicts that match the skill's
 * contract_ref, and surface success / failure totals + last-run-at.
 *
 * Streaming + lazy single-pass index — the audit log can be hundreds of
 * MB on busy machines, so we never `JSON.parse` the whole file. On the
 * first call to the returned resolver, lines are read via a tiny
 * line-buffered reader, parsed individually, and aggregated into:
 *
 *   - Map<contractId, { successesInWindow, failuresInWindow }>
 *     (entries within failWindowMs of `now`)
 *   - Map<contractId, lastRunAtMs>  (entries within statsWindowMs)
 *   - Map<skillId,    lastRunAtMs>  (entries within statsWindowMs)
 *
 * Subsequent per-skill calls are O(1) lookups into these maps. This
 * drops curator runtime from O(N×M) to O(M+N) where M is audit lines
 * and N is skills.
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
import { StringDecoder } from 'node:string_decoder';

import { getGlobalConfig } from '../config/global';
import type { SkillRunStats, SkillStatsResolver } from './curator';
import type { SkillRecord } from './types';

const DEFAULT_FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_STATS_WINDOW_DAYS = 30;

export interface AuditStatsResolverOptions {
  /** Path to the audit log JSONL. Default: reads from global config, then ~/.openchrome/audit.log. */
  auditLogPath?: string;
  /** Failure-rate window in ms. Default 30 days. */
  failWindowMs?: number;
  /**
   * Full scan window in days (controls how far back lastRunAt searches).
   * Defaults to OPENCHROME_SKILL_MEM_STATS_WINDOW_DAYS env var, then 30 days.
   * Decoupled from failWindowMs so a skill last used 31-60 days ago is not
   * falsely treated as never-touched when failWindowMs is 30 days.
   */
  statsWindowDays?: number;
  /** Test hook: clock for "now". */
  now?: () => number;
  /**
   * Override the line reader — tests inject in-memory streams; CLI
   * paths use the default fs-backed reader.
   */
  readLines?: (path: string) => Iterable<string>;
}

export function defaultAuditLogPath(): string {
  const config = getGlobalConfig();
  return (
    config.security?.audit_log_path ||
    path.join(os.homedir(), '.openchrome', 'audit.log')
  );
}

/**
 * Synchronous line-by-line iterator over a possibly-large file.
 * Reads in 64 KB chunks, feeds them through a StringDecoder so
 * multi-byte UTF-8 code points crossing chunk boundaries are handled
 * correctly, splits on `\n`, and yields complete lines.
 */
function* readLinesFromFile(filePath: string): Iterable<string> {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, 'r');
  const CHUNK = 64 * 1024;
  const buf = Buffer.alloc(CHUNK);
  const decoder = new StringDecoder('utf8');
  let leftover = '';
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const text = leftover + decoder.write(buf.slice(0, n));
      const lines = text.split('\n');
      leftover = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    const tail = decoder.end();
    if (tail) leftover += tail;
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

interface AuditIndex {
  /** Win/loss tallies within failWindowMs, keyed by contractId. */
  verdicts: Map<string, { successesInWindow: number; failuresInWindow: number }>;
  /** Most-recent-run timestamp within statsWindowMs, keyed by contractId. */
  lastRunByContract: Map<string, number>;
  /** Most-recent-run timestamp within statsWindowMs, keyed by skillId. */
  lastRunBySkill: Map<string, number>;
}

function buildIndex(
  lines: Iterable<string>,
  now: number,
  failWindowMs: number,
  statsWindowMs: number,
): AuditIndex {
  const failCutoff = now - failWindowMs;
  const statsCutoff = now - statsWindowMs;

  const verdicts = new Map<string, { successesInWindow: number; failuresInWindow: number }>();
  const lastRunByContract = new Map<string, number>();
  const lastRunBySkill = new Map<string, number>();

  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const entry = parsed as RuntimeAuditRow & SkillRunAuditRow;
    const ts = parseTs(entry.ts);
    if (ts === null || ts < statsCutoff) continue;

    if (entry.tool === 'contract_runtime' && entry.args) {
      const cid = entry.args.contract_id;
      if (typeof cid === 'string') {
        // Update lastRunAt for all entries within the stats window.
        const prev = lastRunByContract.get(cid);
        if (prev === undefined || ts > prev) lastRunByContract.set(cid, ts);

        // Win/loss tallies only within the (potentially shorter) fail window.
        if (ts >= failCutoff) {
          let tally = verdicts.get(cid);
          if (!tally) {
            tally = { successesInWindow: 0, failuresInWindow: 0 };
            verdicts.set(cid, tally);
          }
          if (entry.args.verdict === 'success') tally.successesInWindow++;
          else if (entry.args.verdict === 'postcondition_violation') tally.failuresInWindow++;
        }
      }
    }

    if (entry.tool === 'skill_run' && entry.args) {
      const sid = entry.args.skill_id;
      if (typeof sid === 'string') {
        const prev = lastRunBySkill.get(sid);
        if (prev === undefined || ts > prev) lastRunBySkill.set(sid, ts);
      }
    }
  }

  return { verdicts, lastRunByContract, lastRunBySkill };
}

/**
 * Build a SkillStatsResolver bound to a given audit-log path. The
 * index is built lazily on first call — the audit log is scanned once
 * and the result is shared across all per-skill lookups, so curator
 * runtime is O(M+N) rather than O(N×M).
 */
export function createAuditLogStatsResolver(
  opts: AuditStatsResolverOptions = {},
): SkillStatsResolver {
  const auditLogPath = opts.auditLogPath ?? defaultAuditLogPath();
  const failWindowMs = opts.failWindowMs ?? DEFAULT_FAIL_WINDOW_MS;
  const statsWindowDays =
    opts.statsWindowDays ??
    (() => {
      const raw = process.env['OPENCHROME_SKILL_MEM_STATS_WINDOW_DAYS'];
      if (!raw) return DEFAULT_STATS_WINDOW_DAYS;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_STATS_WINDOW_DAYS;
    })();
  const statsWindowMs = statsWindowDays * 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const readLines = opts.readLines ?? readLinesFromFile;

  let index: AuditIndex | null = null;

  return (record: SkillRecord): SkillRunStats => {
    if (!index) {
      index = buildIndex(readLines(auditLogPath), now(), failWindowMs, statsWindowMs);
    }

    const matchContract = record.sidecar.contract_id;
    const matchSkillId = record.skill_id;

    const tally = verdicts_for(index, matchContract);
    const lastRunAt = bestLastRunAt(index, matchContract, matchSkillId);

    return {
      successesInWindow: tally.successesInWindow,
      failuresInWindow: tally.failuresInWindow,
      lastRunAt,
      demotesInDoubleDemoteWindow: 0,
      hadInterveningPromotion: false,
    };
  };
}

function verdicts_for(
  index: AuditIndex,
  contractId: string,
): { successesInWindow: number; failuresInWindow: number } {
  return index.verdicts.get(contractId) ?? { successesInWindow: 0, failuresInWindow: 0 };
}

function bestLastRunAt(
  index: AuditIndex,
  contractId: string,
  skillId: string,
): number | null {
  const byContract = index.lastRunByContract.get(contractId) ?? null;
  const bySkill = index.lastRunBySkill.get(skillId) ?? null;
  if (byContract === null) return bySkill;
  if (bySkill === null) return byContract;
  return byContract > bySkill ? byContract : bySkill;
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
