/**
 * Execution modes for the Agent Task Success axis (#1257).
 *
 * Issue #1257 distinguishes two ways a library can be measured against the
 * same task corpus:
 *
 * - `native`: each library runs in its idiomatic execution mode. OpenChrome
 *   and playwright-mcp inside a Claude tool-calling loop (their natural MCP
 *   shape). browser-use inside its own native agent loop with the pinned
 *   Claude model. This is the HEADLINE comparison.
 *
 * - `passive`: every library wrapped as a passive tool surface inside an
 *   identical Claude tool-calling loop. Isolates the tool surface itself,
 *   but for browser-use this strips the library's planning loop — so it is
 *   reported as a SECONDARY data point, never the headline.
 *
 * Epic #1254 fairness principle: passive results MUST appear in their own
 * envelope section with the "secondary" tag so a reader cannot mistake
 * "Claude + a hobbled browser-use" for browser-use's real native-mode
 * score.
 *
 * Per-task chart claims are gated at N >= 20 samples; aggregate (suite-
 * level) claims use bootstrap 95% CI over the task set with N >= 10. The
 * `gateClaim()` helper below is the small, unit-testable enforcer the
 * report renderer calls.
 */

export type ExecutionMode = 'native' | 'passive';

export const EXECUTION_MODES: readonly ExecutionMode[] = ['native', 'passive'];

/**
 * Minimum samples per (library, task) cell for an aggregate / suite-level
 * claim ("OpenChrome passes X / 60 tasks at 95% CI"). Below this threshold
 * the suite number is reported with the explicit "underpowered (N<10)"
 * annotation.
 */
export const AGGREGATE_MIN_N = 10;

/**
 * Minimum samples per (library, task) cell for a PER-TASK claim in the
 * breakdown chart ("OpenChrome passes task-42 95% of the time"). Issue
 * #1257 mandates N >= 20 here because binary pass/fail at lower N has
 * observed-rate error ≥ ±20 percentage points.
 */
export const PER_TASK_MIN_N = 20;

export type ClaimScope = 'aggregate' | 'per-task';

export interface ClaimGateResult {
  scope: ClaimScope;
  sampleCount: number;
  /** Threshold the scope requires. */
  required: number;
  /** True when the claim is allowed; false ⇒ render with "underpowered" tag. */
  allowed: boolean;
  /** Annotation for the report renderer when allowed === false. */
  annotation: string;
}

/**
 * Decide whether a claim of `scope` can be rendered given `sampleCount`
 * samples. The renderer always emits the row; this gate only decides
 * whether the row should carry the "underpowered" annotation.
 */
export function gateClaim(scope: ClaimScope, sampleCount: number): ClaimGateResult {
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new Error(`sampleCount must be a non-negative integer, got ${sampleCount}`);
  }
  const required = scope === 'per-task' ? PER_TASK_MIN_N : AGGREGATE_MIN_N;
  const allowed = sampleCount >= required;
  const annotation = allowed
    ? ''
    : `underpowered (N=${sampleCount} < ${required} required for ${scope})`;
  return { scope, sampleCount, required, allowed, annotation };
}

/**
 * Bootstrap 95% CI of a binary pass/fail mean using percentile bootstrap.
 * Exported as a pure function so the report renderer can compute it without
 * spinning up the real `BenchmarkRunner` orchestration.
 *
 * `iterations` defaults to 1000 (cheap; deterministic with a seeded RNG).
 * Returns [lower, upper] in the range [0, 1].
 */
export function bootstrapPassRateCi95(
  outcomes: readonly boolean[],
  iterations = 1000,
  seed = 42,
): [number, number] {
  if (outcomes.length === 0) return [0, 0];
  const n = outcomes.length;
  // Tiny LCG so the CI is deterministic across runs without pulling in a
  // dep. Not crypto, just reproducibility.
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rand() * n);
      if (outcomes[idx]) sum += 1;
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * iterations)];
  const hi = means[Math.floor(0.975 * iterations)];
  return [lo, hi];
}
