/**
 * Reliability metric core for the Reliability & Fault-Recovery axis (#1259).
 *
 * Pure scoring functions — the fault-injection harness that feeds them (CDP +
 * proxy injectors) is a separate work unit. This module turns raw run
 * outcomes into the three headline reliability numbers:
 *   - flaky rate          (determinism of repeated runs)
 *   - fault-recovery rate (per injected fault type)
 *   - long-run stability  (memory-leak detection from an RSS sample series)
 */

/** Fault types injected by the reliability harness — chosen from first
 *  principles as the failure modes any browser automation faces. */
export type FaultType =
  | 'stale-selector'
  | 'network-drop'
  | 'tab-crash'
  | 'unexpected-modal'
  | 'cdp-drop';

export const FAULT_TYPES: readonly FaultType[] = [
  'stale-selector',
  'network-drop',
  'tab-crash',
  'unexpected-modal',
  'cdp-drop',
];

/**
 * Minimum sample size for a flaky-rate measurement. Per the #1259 design
 * review, N must be >= 50 — at N=20 the metric resolves only to ~5pp.
 */
export const MIN_FLAKY_SAMPLE_SIZE = 50;

export interface FlakyRateResult {
  n: number;
  successCount: number;
  /** Count of the most common outcome (whichever of success/failure dominates). */
  modeOutcomeCount: number;
  /** 1 - modeOutcomeCount/N. 0 = perfectly deterministic; 0.5 = maximally flaky. */
  flakyRate: number;
  successRate: number;
}

/**
 * Flaky rate over N repetitions of the same task. Lower is better — 0 means
 * every run agreed. `minSamples` defaults to MIN_FLAKY_SAMPLE_SIZE; pass a
 * lower value only in unit tests that exercise the arithmetic directly.
 */
export function computeFlakyRate(
  outcomes: boolean[],
  options: { minSamples?: number } = {},
): FlakyRateResult {
  const n = outcomes.length;
  const minSamples = options.minSamples ?? MIN_FLAKY_SAMPLE_SIZE;
  if (n < Math.max(1, minSamples)) {
    throw new Error(
      `flaky rate needs >= ${minSamples} samples (got ${n}); a smaller N cannot ` +
        'resolve the metric finely enough to compare libraries',
    );
  }
  const successCount = outcomes.filter(Boolean).length;
  const failureCount = n - successCount;
  const modeOutcomeCount = Math.max(successCount, failureCount);
  return {
    n,
    successCount,
    modeOutcomeCount,
    flakyRate: 1 - modeOutcomeCount / n,
    successRate: successCount / n,
  };
}

export interface RecoveryRecord {
  faultType: FaultType;
  recovered: boolean;
  /** Tool calls taken to recover, when recovered. */
  stepsToRecover?: number;
  /** Wall-clock ms taken to recover, when recovered. */
  timeToRecoverMs?: number;
}

export interface RecoveryRateByFault {
  faultType: FaultType;
  injected: number;
  recovered: number;
  /** recovered / injected, in [0, 1]. */
  recoveryRate: number;
  /** Mean steps over recovered runs only, or null if none recovered. */
  meanStepsToRecover: number | null;
  /** Mean time over recovered runs only, or null if none recovered. */
  meanTimeToRecoverMs: number | null;
}

function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate per-fault-type recovery rate from a flat list of recovery
 * records. A competitor that simply throws on a fault yields recovered=false
 * records — a legitimate result, recorded as recoveryRate 0, not an error.
 * Only fault types that actually appear in the input are returned.
 */
export function aggregateRecoveryRate(records: RecoveryRecord[]): RecoveryRateByFault[] {
  const byType = new Map<FaultType, RecoveryRecord[]>();
  for (const record of records) {
    const bucket = byType.get(record.faultType) ?? [];
    bucket.push(record);
    byType.set(record.faultType, bucket);
  }

  const result: RecoveryRateByFault[] = [];
  for (const faultType of FAULT_TYPES) {
    const bucket = byType.get(faultType);
    if (!bucket || bucket.length === 0) continue;
    const recoveredRecords = bucket.filter((r) => r.recovered);
    result.push({
      faultType,
      injected: bucket.length,
      recovered: recoveredRecords.length,
      recoveryRate: recoveredRecords.length / bucket.length,
      meanStepsToRecover: meanOrNull(
        recoveredRecords
          .map((r) => r.stepsToRecover)
          .filter((v): v is number => typeof v === 'number'),
      ),
      meanTimeToRecoverMs: meanOrNull(
        recoveredRecords
          .map((r) => r.timeToRecoverMs)
          .filter((v): v is number => typeof v === 'number'),
      ),
    });
  }
  return result;
}

export interface StabilitySample {
  /** Milliseconds since the run started. */
  tMs: number;
  /** Process RSS in bytes at that moment. */
  rssBytes: number;
}

export interface StabilitySummary {
  sampleCount: number;
  durationMs: number;
  firstRssBytes: number;
  lastRssBytes: number;
  /** Least-squares slope of RSS over time, in bytes/sec. > 0 suggests a leak. */
  rssSlopeBytesPerSec: number;
  /** (last - first) / first. */
  rssGrowthRatio: number;
  /** True when growth exceeds the leak threshold over the run. */
  suspectedLeak: boolean;
}

/**
 * Summarize a long-run RSS sample series for memory-leak detection. Uses a
 * least-squares fit of RSS over time plus an end-to-end growth ratio; a leak
 * is flagged when growth exceeds `leakThresholdRatio` (default 0.5 = +50%).
 */
export function summarizeStability(
  samples: StabilitySample[],
  options: { leakThresholdRatio?: number } = {},
): StabilitySummary {
  if (samples.length < 2) {
    throw new Error('summarizeStability requires at least 2 samples');
  }
  const leakThresholdRatio = options.leakThresholdRatio ?? 0.5;
  const ordered = [...samples].sort((a, b) => a.tMs - b.tMs);
  const n = ordered.length;

  // Least-squares slope of rssBytes over tMs.
  const meanT = ordered.reduce((s, p) => s + p.tMs, 0) / n;
  const meanR = ordered.reduce((s, p) => s + p.rssBytes, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of ordered) {
    num += (p.tMs - meanT) * (p.rssBytes - meanR);
    den += (p.tMs - meanT) ** 2;
  }
  const slopeBytesPerMs = den === 0 ? 0 : num / den;

  const firstRssBytes = ordered[0].rssBytes;
  const lastRssBytes = ordered[n - 1].rssBytes;
  const rssGrowthRatio = firstRssBytes === 0 ? 0 : (lastRssBytes - firstRssBytes) / firstRssBytes;

  return {
    sampleCount: n,
    durationMs: ordered[n - 1].tMs - ordered[0].tMs,
    firstRssBytes,
    lastRssBytes,
    rssSlopeBytesPerSec: slopeBytesPerMs * 1000,
    rssGrowthRatio,
    suspectedLeak: rssGrowthRatio > leakThresholdRatio,
  };
}
