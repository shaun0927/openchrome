/**
 * Sidecar-backed `SkillStatsResolver` for the curator runner.
 *
 * Replaces `noopStatsResolver` (`runner.ts`), which treated every
 * skill as healthy and effectively disabled the prune sub-passes.
 *
 * Source of truth: each skill's `.json` sidecar (`SkillSidecar`)
 * already holds a rolling 30-day log of `(txn_id, ok, ts)` entries.
 * `recordSuccessfulRun` writes `ok: true`; the new `recordFailedRun`
 * writes `ok: false` for `postcondition_violation` settlements. The
 * resolver does the count: successes and failures within
 * `windowMs` (default the rolling 30-day window the sidecar itself
 * uses), plus the most recent entry's timestamp as `lastRunAt`.
 *
 * Known limitation — `demotesInDoubleDemoteWindow` is always 0.
 * Tracking demote history would require either an in-place sidecar
 * extension (bumping `SKILL_SCHEMA_VERSION`) or a sidecar audit
 * file. Until that lands, the curator's prune sub-pass simply
 * degrades to "demote always; never archive on double-demote",
 * which matches the existing `noopStatsResolver` behaviour for the
 * archive path and adds real demote enforcement on the demote path.
 */

import type {
  SkillRecord,
  SkillRunStats,
  SkillStatsResolver,
} from '../curator/index.js';

export interface SidecarStatsResolverOptions {
  /**
   * Window to count over, in ms. Defaults to the 30-day rolling
   * window the sidecar itself uses. Passing a tighter window here
   * lets `runPrune({ failWindowMs: ... })` evaluate a shorter
   * confidence floor without re-trimming the sidecar.
   */
  defaultWindowMs?: number;
  /** Test hook: clock. */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function createSidecarStatsResolver(
  opts: SidecarStatsResolverOptions = {},
): SkillStatsResolver {
  const defaultWindow = opts.defaultWindowMs ?? DEFAULT_WINDOW_MS;
  const clock = opts.now ?? Date.now;

  return (record: SkillRecord, windowMs?: number): SkillRunStats => {
    const window = typeof windowMs === 'number' && windowMs > 0 ? windowMs : defaultWindow;
    const cutoff = clock() - window;

    const recent = record.sidecar?.runs?.recent;
    if (!Array.isArray(recent) || recent.length === 0) {
      return {
        successesInWindow: 0,
        failuresInWindow: 0,
        lastRunAt: null,
        demotesInDoubleDemoteWindow: 0,
      };
    }

    let successes = 0;
    let failures = 0;
    let lastRunAt: number | null = null;
    for (const e of recent) {
      if (!e || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) continue;
      if (e.ts < cutoff) continue;
      if (e.ok === true) successes++;
      else if (e.ok === false) failures++;
      if (lastRunAt === null || e.ts > lastRunAt) lastRunAt = e.ts;
    }

    return {
      successesInWindow: successes,
      failuresInWindow: failures,
      lastRunAt,
      // See module docstring — demote history is not yet tracked.
      demotesInDoubleDemoteWindow: 0,
    };
  };
}
