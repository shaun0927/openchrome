/**
 * Audit-log-backed SkillStatsResolver (Phase 4, replaces #766).
 *
 * Derives canonical (successCount, lastUsedAt) per skill by walking the
 * audit log JSONL in a single streaming pass. Defensive against in-DB counter
 * races — this module only reads; callers decide what to do with disagreements.
 *
 * Design:
 *   - Streams ~/.openchrome/audit.log (or configured path) in 64 KB chunks.
 *   - Filters `tool === 'skill_run'` entries within the configured windows.
 *   - Groups by skill_id → (successesInWindow, failuresInWindow, lastRunAt).
 *   - Index is built lazily on first call and shared across all per-skill
 *     lookups: O(M+N) rather than O(N×M).
 *   - Demote-history fields deferred to a future history store; default
 *     conservatively to 0 / false so the curator's double-demote path stays
 *     inactive.
 *
 * Core-tier: no pilot imports, no flag gate (read-only fact computation).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { getGlobalConfig } from '../../config/global';
import type { SkillRecord } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-skill run statistics derived from the audit log. */
export interface SkillRunStats {
  /** Number of successful runs within the fail window. */
  successesInWindow: number;
  /** Number of postcondition-violation runs within the fail window. */
  failuresInWindow: number;
  /**
   * Most-recent skill_run timestamp (ms epoch) within the stats window,
   * or null when the skill has no recorded runs in that window.
   */
  lastRunAt: number | null;
  /**
   * Demotions within the double-demote archive window. Deferred to the
   * curator's own history store — defaults to 0 until that lands.
   */
  demotesInDoubleDemoteWindow: number;
  /**
   * Whether there was an intervening promotion between the last two
   * demotions. Deferred — defaults to false.
   */
  hadInterveningPromotion: boolean;
}

/** A function that maps a SkillRecord to its run statistics. */
export type SkillStatsResolver = (record: SkillRecord) => SkillRunStats;

/** Options for createAuditLogStatsResolver. */
export interface AuditStatsResolverOptions {
  /** Path to the audit log JSONL. Default: global config, then ~/.openchrome/audit.log. */
  auditLogPath?: string;
  /** Failure-rate window in ms. Default: 30 days. */
  failWindowMs?: number;
  /**
   * Full scan window in days (controls how far back lastRunAt searches).
   * Defaults to OPENCHROME_SKILL_MEM_STATS_WINDOW_DAYS env var, then 60 days.
   *
   * Must be >= the curator's untouched-archive horizon (60 days) so a skill
   * last run 31-60 days ago is not mistakenly treated as "never touched" and
   * archived prematurely. Decoupled from failWindowMs so success/failure
   * tallies can use a tighter window while lastRunAt uses the full horizon.
   */
  statsWindowDays?: number;
  /** Test hook: clock for "now". */
  now?: () => number;
  /**
   * Override the line reader — tests inject in-memory iterables; the
   * default uses an fs-backed streaming reader.
   */
  readLines?: (filePath: string) => Iterable<string>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Must be >= curator's untouched-archive horizon (60 days). See comment on
// statsWindowDays above.
const DEFAULT_STATS_WINDOW_DAYS = 60;

// ---------------------------------------------------------------------------
// Audit log path
// ---------------------------------------------------------------------------

export function defaultAuditLogPath(): string {
  const config = getGlobalConfig();
  return (
    config.security?.audit_log_path ||
    path.join(os.homedir(), '.openchrome', 'audit.log')
  );
}

// ---------------------------------------------------------------------------
// Streaming line reader
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Audit row shape (subset we care about)
// ---------------------------------------------------------------------------

interface SkillRunAuditRow {
  ts?: unknown;
  tool?: string;
  args?: {
    skill_id?: string;
    verdict?: string;
    contract_id?: string;
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

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

interface AuditIndex {
  /** Win/loss tallies within failWindowMs, keyed by skill_id. */
  verdicts: Map<string, { successesInWindow: number; failuresInWindow: number }>;
  /** Most-recent skill_run timestamp within statsWindowMs, keyed by skill_id. */
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
  // Use the wider of the two cutoffs so rows relevant to EITHER metric are
  // not dropped before per-metric accounting runs. Without this, a narrow
  // statsWindowDays could silently truncate failure tallies (P2 regression).
  const wideCutoff = Math.min(statsCutoff, failCutoff);

  const verdicts = new Map<string, { successesInWindow: number; failuresInWindow: number }>();
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
    const entry = parsed as SkillRunAuditRow;
    const ts = parseTs(entry.ts);
    if (ts === null || ts < wideCutoff) continue;

    if (entry.tool === 'skill_run' && entry.args) {
      const sid = entry.args.skill_id;
      if (typeof sid !== 'string') continue;

      // lastRunAt: keyed by skill_id, only within the stats window.
      if (ts >= statsCutoff) {
        const prev = lastRunBySkill.get(sid);
        if (prev === undefined || ts > prev) lastRunBySkill.set(sid, ts);
      }

      // Verdict tallies: keyed by skill_id, only within the fail window.
      // Scoping by skill_id prevents sibling skills sharing the same
      // contract_id from polluting each other's stats (P1 regression).
      if (ts >= failCutoff) {
        let tally = verdicts.get(sid);
        if (!tally) {
          tally = { successesInWindow: 0, failuresInWindow: 0 };
          verdicts.set(sid, tally);
        }
        if (entry.args.verdict === 'success') tally.successesInWindow++;
        else if (entry.args.verdict === 'postcondition_violation') tally.failuresInWindow++;
      }
    }
  }

  return { verdicts, lastRunBySkill };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a SkillStatsResolver bound to a given audit-log path. The index is
 * built lazily on first call — the audit log is scanned once and the result
 * is shared across all per-skill lookups (O(M+N) rather than O(N×M)).
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
  const nowFn = opts.now ?? Date.now;
  const readLines = opts.readLines ?? readLinesFromFile;

  let index: AuditIndex | null = null;

  return (record: SkillRecord): SkillRunStats => {
    if (!index) {
      index = buildIndex(readLines(auditLogPath), nowFn(), failWindowMs, statsWindowMs);
    }

    const tally = index.verdicts.get(record.skillId) ?? {
      successesInWindow: 0,
      failuresInWindow: 0,
    };
    const lastRunAt = index.lastRunBySkill.get(record.skillId) ?? null;

    return {
      successesInWindow: tally.successesInWindow,
      failuresInWindow: tally.failuresInWindow,
      lastRunAt,
      demotesInDoubleDemoteWindow: 0,
      hadInterveningPromotion: false,
    };
  };
}

/**
 * Convenience: build a resolver backed by an in-memory line array.
 * Useful when the caller wants to amortize one file read across many
 * skills, or in tests that inject pre-built log lines.
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
