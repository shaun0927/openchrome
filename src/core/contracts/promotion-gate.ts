/**
 * Promotion gate — evaluate whether a SchemaDiff represents a contract
 * success that's strong enough to promote a skill/selector record into
 * verified memory (B1-PR3 of #1359).
 *
 * Per #1359 §P6 (verified memory only), the curator promotes records only
 * from contract-verified successes. The schema-diff B1 thread emits
 * structured facts (matched, missing, extra, typeMismatch, coverage); this
 * module is the deterministic policy that turns those facts into a
 * promote/skip decision.
 *
 * Pure function. No I/O. No Chrome dependency. Callers (curator,
 * benchmark harness, host LLM) pass a {@link SchemaDiff} and an optional
 * threshold record; the gate returns the decision plus a structured
 * `reasons` array that downstream tracing/audit consumes.
 *
 * Defaults (chosen to be conservative for a default promotion bar):
 *
 *   - `minCoverage = 0.8` — require 80 % of required fields matched
 *   - `maxTypeMismatch = 0` — any type mismatch blocks promotion
 *   - `requireZeroMissing = false` — partial-match still promotes if
 *     coverage clears the bar (callers can tighten this)
 *
 * Callers that need a different bar pass an `opts` record. The defaults
 * never silently change once set; behaviour changes require a version
 * bump in the policy module.
 */

import type { SchemaDiff } from './schema-diff';

export interface PromotionGateOptions {
  /** Minimum coverage (matched_required / required_total). Default 0.8. */
  minCoverage?: number;
  /** Max allowed type mismatches. Default 0. */
  maxTypeMismatch?: number;
  /**
   * When true, any required field listed in `missing` blocks promotion
   * regardless of coverage. Default false.
   */
  requireZeroMissing?: boolean;
}

export interface PromotionGateDecision {
  eligible: boolean;
  /**
   * Structured reasons the gate evaluated. Always present — empty array
   * means "no concerns observed". Lets callers attach the gate's
   * verdict to audit trails without re-deriving the policy.
   */
  reasons: PromotionGateReason[];
  /** The coverage value the gate compared against the bar. */
  coverage: number;
  /** The bar the gate compared against (after applying defaults). */
  threshold: Required<PromotionGateOptions>;
}

export type PromotionGateReason =
  | { kind: 'coverage_below_bar'; coverage: number; required: number }
  | { kind: 'type_mismatch_present'; count: number; max: number; fields: string[] }
  | { kind: 'missing_required_fields'; fields: string[] }
  | { kind: 'pass' };

const DEFAULTS: Required<PromotionGateOptions> = {
  minCoverage: 0.8,
  maxTypeMismatch: 0,
  requireZeroMissing: false,
};

function resolveOptions(opts: PromotionGateOptions | undefined): Required<PromotionGateOptions> {
  if (!opts) return DEFAULTS;
  return {
    minCoverage: typeof opts.minCoverage === 'number' && Number.isFinite(opts.minCoverage)
      ? Math.max(0, Math.min(1, opts.minCoverage))
      : DEFAULTS.minCoverage,
    maxTypeMismatch: typeof opts.maxTypeMismatch === 'number' && Number.isFinite(opts.maxTypeMismatch)
      ? Math.max(0, Math.floor(opts.maxTypeMismatch))
      : DEFAULTS.maxTypeMismatch,
    requireZeroMissing: opts.requireZeroMissing === true,
  };
}

/**
 * Evaluate whether a SchemaDiff clears the promotion bar.
 *
 * Idempotent and side-effect-free. Returns a structured decision —
 * callers attach `reasons` to audit records and act on `eligible`.
 */
export function shouldPromoteFromSchemaDiff(
  diff: SchemaDiff,
  opts?: PromotionGateOptions,
): PromotionGateDecision {
  const threshold = resolveOptions(opts);
  const reasons: PromotionGateReason[] = [];

  if (diff.coverage < threshold.minCoverage) {
    reasons.push({
      kind: 'coverage_below_bar',
      coverage: diff.coverage,
      required: threshold.minCoverage,
    });
  }

  if (diff.typeMismatch.length > threshold.maxTypeMismatch) {
    reasons.push({
      kind: 'type_mismatch_present',
      count: diff.typeMismatch.length,
      max: threshold.maxTypeMismatch,
      fields: diff.typeMismatch.map(m => m.field),
    });
  }

  if (threshold.requireZeroMissing && diff.missing.length > 0) {
    reasons.push({ kind: 'missing_required_fields', fields: diff.missing });
  }

  if (reasons.length === 0) {
    reasons.push({ kind: 'pass' });
    return { eligible: true, reasons, coverage: diff.coverage, threshold };
  }

  return { eligible: false, reasons, coverage: diff.coverage, threshold };
}
