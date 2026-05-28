/**
 * Marginal-utility tracker for task episodes (issue #1428, Part 1).
 *
 * Each tool call is a "step". After every step we update a sliding-window
 * estimate of p_success (the probability the episode ends successfully).
 *
 * Formula
 * -------
 * p_success is maintained as a weighted-average score in [0, 1]:
 *
 *   base_weight  = WINDOW_SIZE − window_index   (older = lighter)
 *   step_score   = passes − failures + 0.5 * inconclusives + checkpoints
 *                  ─────────────────────────────────────────────────────
 *                  passes + failures + inconclusives + (checkpoint ? 1 : 0)
 *
 * When no oc_assert signals arrive in a step, tool success/failure drives
 * a smaller signal:
 *   step_score = 0.7  (tool ok, no asserts)
 *   step_score = 0.3  (tool error, no asserts)
 *
 * p_success is the weighted average of step_scores in the sliding window.
 * delta = p_success_now − p_success_previous.
 *
 * The tracker is intentionally simple and deterministic — no ML, no
 * clocks (callers supply timestamps). Identical inputs always produce
 * identical outputs.
 */

/** Maximum number of steps kept in the sliding window. */
const WINDOW_SIZE = 20;

/**
 * Per-step aggregated signals fed to `recordStep`.
 *
 * All counts are non-negative integers. `toolOk` reflects the outcome
 * of the tool call that triggered this step (true = no MCP error).
 */
export interface StepSignals {
  /** Unix ms timestamp supplied by the caller (no internal Date.now()). */
  ts: number;
  /** Whether the triggering tool call returned without error. */
  toolOk: boolean;
  /** Number of oc_assert calls in this step that returned verdict "pass". */
  assertPasses: number;
  /** Number of oc_assert calls that returned verdict "fail". */
  assertFails: number;
  /** Number of oc_assert calls that returned verdict "inconclusive". */
  assertInconclusives: number;
  /**
   * Whether a checkpoint advance occurred during this step (e.g. the
   * host advanced task phase or oc_checkpoint was called).
   */
  checkpointAdvanced: boolean;
}

/** One entry in the sliding window. Stored for traceability. */
export interface StepRecord {
  step: number;
  ts: number;
  p: number;
  delta: number;
}

/**
 * Sliding-window state for the marginal-utility tracker.
 * Treat as opaque — mutate only via `recordStep`.
 */
export interface MarginalUtilityState {
  /** Total number of steps recorded (monotonically increasing). */
  totalSteps: number;
  /** Sliding window of the most recent WINDOW_SIZE step records. */
  window: StepRecord[];
  /** p_success after the last step (0.5 initial prior). */
  lastP: number;
}

/** Summary returned by `summary()`. */
export interface MarginalUtilitySummary {
  /** p_success estimate after the latest step (0 – 1). */
  last_p: number;
  /** Average Δp per step over the current window. */
  mean_delta_per_step: number;
  /**
   * Number of consecutive steps at the tail of the window where
   * |delta| < LOW_DELTA_THRESHOLD — indicates a plateau.
   */
  consecutive_low_delta: number;
}

/** |delta| below this is considered "low" (plateau indicator). */
const LOW_DELTA_THRESHOLD = 0.02;

/**
 * Create a fresh MarginalUtilityState with a neutral 0.5 prior.
 */
export function initialMarginalUtilityState(): MarginalUtilityState {
  return { totalSteps: 0, window: [], lastP: 0.5 };
}

/**
 * Pure function. Records one step and returns a new state.
 *
 * The caller is responsible for aggregating signals from all events that
 * occurred during a single tool-call round-trip into one `StepSignals`
 * object before calling this function.
 */
export function recordStep(
  state: MarginalUtilityState,
  signals: StepSignals,
): MarginalUtilityState {
  const stepIndex = state.totalSteps + 1;
  const score = computeStepScore(signals);

  // Build the new window (limited to WINDOW_SIZE entries).
  const prevWindow = state.window;
  const candidateWindow: StepRecord[] = prevWindow.length >= WINDOW_SIZE
    ? prevWindow.slice(prevWindow.length - (WINDOW_SIZE - 1))
    : [...prevWindow];

  // Compute new p_success as weighted average over the window + current step.
  // Weights: oldest entry gets weight 1, newest gets weight WINDOW_SIZE.
  const scores = candidateWindow.map((r) => r.p);
  scores.push(score);
  const n = scores.length;
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = i + 1; // weight 1 for oldest, n for newest
    weightedSum += scores[i] * w;
    totalWeight += w;
  }
  const newP = totalWeight > 0 ? weightedSum / totalWeight : score;
  const delta = newP - state.lastP;

  const record: StepRecord = {
    step: stepIndex,
    ts: signals.ts,
    p: newP,
    delta,
  };

  return {
    totalSteps: stepIndex,
    window: [...candidateWindow, record],
    lastP: newP,
  };
}

/**
 * Return a concise summary of the current tracker state.
 */
export function summary(state: MarginalUtilityState): MarginalUtilitySummary {
  const { window: win, lastP } = state;

  if (win.length === 0) {
    return { last_p: lastP, mean_delta_per_step: 0, consecutive_low_delta: 0 };
  }

  const meanDelta = win.reduce((acc, r) => acc + r.delta, 0) / win.length;

  let consecutiveLow = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    if (Math.abs(win[i].delta) < LOW_DELTA_THRESHOLD) {
      consecutiveLow++;
    } else {
      break;
    }
  }

  return {
    last_p: lastP,
    mean_delta_per_step: meanDelta,
    consecutive_low_delta: consecutiveLow,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert per-step signals into a [0, 1] score.
 *
 * When assert signals are present they dominate. When absent, tool success
 * provides a weak 0.7/0.3 signal.
 */
function computeStepScore(signals: StepSignals): number {
  const {
    assertPasses,
    assertFails,
    assertInconclusives,
    checkpointAdvanced,
    toolOk,
  } = signals;

  const checkpointBonus = checkpointAdvanced ? 1 : 0;
  const assertTotal = assertPasses + assertFails + assertInconclusives;
  const denominator = assertTotal + checkpointBonus;

  if (denominator === 0) {
    // No assert or checkpoint signals — fall back to tool success heuristic.
    return toolOk ? 0.7 : 0.3;
  }

  // score = (passes + 0.5*inconclusives + checkpoint) / denominator
  // failures subtract — they pull the numerator down by having no contribution
  // while still increasing the denominator.
  const numerator = assertPasses + 0.5 * assertInconclusives + checkpointBonus;
  return Math.max(0, Math.min(1, numerator / denominator));
}
