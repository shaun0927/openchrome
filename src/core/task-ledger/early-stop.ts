/**
 * Early-stop policy for episode budgets (#1428 Part 2).
 *
 * Pure function. Reads a MarginalUtilitySummary (Part 1) and decides
 * whether the host should stop work even before the hard step budget
 * is exhausted. The policy targets Webwright's empirical observation
 * that "the next 50 steps deliver only 3–4 additional accuracy points"
 * — once p_success has plateaued for N consecutive steps, additional
 * spend is unlikely to move the needle.
 *
 * The plateau is detected upstream by the marginal-utility tracker
 * (`consecutive_low_delta`, gated by the tracker's own
 * `LOW_DELTA_THRESHOLD`); this policy only thresholds that count, so it
 * deliberately does not re-expose a per-step delta knob it cannot honor.
 *
 * Crucially this module ONLY recommends. It does not raise, does not
 * mutate anything, and never decides on behalf of the host. The host
 * remains the sole authority on when to stop (SSOT #1359, P3 host
 * neutrality).
 */

import type { MarginalUtilitySummary } from './marginal-utility';

/** Default plateau length: 10 consecutive low-Δ steps. */
export const DEFAULT_PLATEAU_STEPS = 10;
/** Minimum p_success that must be reached before any stop recommendation. */
export const DEFAULT_MIN_P_FOR_STOP = 0.7;

export interface EarlyStopPolicy {
  /**
   * Number of consecutive plateau steps required to recommend stop.
   * A "plateau step" is decided upstream by the marginal-utility
   * tracker (`consecutive_low_delta`); this knob only sets how many of
   * them must accumulate.
   */
  plateau_steps?: number;
  /**
   * Only recommend stop when last_p meets this minimum. Pass `0` to
   * disable the p_success gate entirely (plateau alone then suffices).
   */
  min_p_for_stop?: number;
}

export interface EarlyStopRecommendation {
  /** True iff the policy recommends stopping now. */
  should_stop: boolean;
  /**
   * One-line human-readable reason. Always populated, even when
   * `should_stop` is false — used by the host to surface the policy's
   * current verdict in journals / dashboards.
   */
  reason: string;
  /** Snapshot of the policy that produced this recommendation. */
  policy: Required<EarlyStopPolicy>;
}

function resolved(policy?: EarlyStopPolicy): Required<EarlyStopPolicy> {
  return {
    plateau_steps:
      typeof policy?.plateau_steps === 'number' && policy.plateau_steps > 0
        ? Math.floor(policy.plateau_steps)
        : DEFAULT_PLATEAU_STEPS,
    min_p_for_stop:
      typeof policy?.min_p_for_stop === 'number' &&
      policy.min_p_for_stop >= 0 &&
      policy.min_p_for_stop <= 1
        ? policy.min_p_for_stop
        : DEFAULT_MIN_P_FOR_STOP,
  };
}

/**
 * Decide whether to stop based on the latest marginal-utility summary.
 *
 * The rule is intentionally simple and observable:
 *
 *   should_stop = (last_p >= min_p_for_stop) AND
 *                 (consecutive_low_delta >= plateau_steps)
 *
 * The first conjunct prevents the policy from recommending stop while
 * the episode is still failing (low p_success + flat = stuck, not
 * done). The second is the Webwright "additional steps deliver no
 * marginal benefit" condition.
 */
export function recommendEarlyStop(
  summary: MarginalUtilitySummary,
  policy?: EarlyStopPolicy,
): EarlyStopRecommendation {
  const r = resolved(policy);

  if (!Number.isFinite(summary.last_p)) {
    return {
      should_stop: false,
      reason: `last_p is not finite (${summary.last_p}); refusing to recommend stop`,
      policy: r,
    };
  }

  if (summary.last_p < r.min_p_for_stop) {
    return {
      should_stop: false,
      reason: `last_p=${summary.last_p.toFixed(3)} below min_p_for_stop=${r.min_p_for_stop}`,
      policy: r,
    };
  }

  if (summary.consecutive_low_delta < r.plateau_steps) {
    return {
      should_stop: false,
      reason: `consecutive_low_delta=${summary.consecutive_low_delta} below plateau_steps=${r.plateau_steps}`,
      policy: r,
    };
  }

  return {
    should_stop: true,
    reason: `plateau reached: last_p=${summary.last_p.toFixed(3)} consecutive_low_delta=${summary.consecutive_low_delta}`,
    policy: r,
  };
}
