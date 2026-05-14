/**
 * Token-efficiency scoring core for the Token Efficiency axis (#1256).
 *
 * Every library's page payload is scored on two things:
 *   1. token cost — exact cl100k_base token count of the payload (#1255)
 *   2. retention  — did the payload actually preserve the page's key fields?
 *
 * Retention is the metric that stops "innerText is smallest, so it wins" from
 * being a false conclusion. Critically (a P0 fix from the #1256 design
 * review): retention is scored against a library's *structured / parsed*
 * extraction, NOT a substring match against a raw blob — a tool that dumps raw
 * HTML must not score 100% retention just because every value happens to exist
 * somewhere in the dump. This module only accepts structured, field-keyed
 * extractions, which enforces that rule by construction.
 */

import { countTokens } from './utils/tokenizer';

/** A single expected field of a fixture's ground truth. */
export interface GroundTruthField {
  /** Stable field key, e.g. "title", "price", "primaryCta". */
  key: string;
  /** Expected value, pre-normalization. */
  expected: string;
}

/**
 * The ground-truth spec for one fixture. Per the #1256 design review, this
 * must carry >= 12 fields so the retention metric is not quantized into
 * uselessly coarse buckets (3 fields => only {0, 33, 67, 100}%).
 */
export interface GroundTruthSpec {
  fixture: string;
  fields: GroundTruthField[];
}

export const MIN_GROUND_TRUTH_FIELDS = 12;

/**
 * Documented normalization applied to BOTH the expected value and the
 * extracted value before comparison: strip markup, collapse whitespace, trim,
 * lowercase. Committed up front so "present" has one precise, uniform meaning.
 */
export function normalizeValue(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ') // strip markup
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim()
    .toLowerCase();
}

export interface RetentionResult {
  fixture: string;
  fieldsTotal: number;
  fieldsRetained: number;
  /** fieldsRetained / fieldsTotal, in [0, 1]. */
  retention: number;
  /** Keys that were expected but missing, null, or mismatched. */
  missingKeys: string[];
}

/**
 * Compute the information-retention rate of a library's *structured*
 * extraction against a fixture's ground truth.
 *
 * `extracted` is a field-keyed record — the library's parsed output, never a
 * raw blob. A field is "retained" when its normalized extracted value equals
 * the normalized expected value. Missing keys, null/undefined values, and
 * mismatches all count as not-retained.
 */
export function computeRetention(
  extracted: Record<string, string | null | undefined>,
  groundTruth: GroundTruthSpec,
): RetentionResult {
  if (groundTruth.fields.length < MIN_GROUND_TRUTH_FIELDS) {
    throw new Error(
      `ground truth for "${groundTruth.fixture}" has ${groundTruth.fields.length} fields; ` +
        `>= ${MIN_GROUND_TRUTH_FIELDS} required so retention is not coarsely quantized`,
    );
  }
  const missingKeys: string[] = [];
  let retained = 0;
  for (const field of groundTruth.fields) {
    const actual = extracted[field.key];
    if (typeof actual === 'string' && normalizeValue(actual) === normalizeValue(field.expected)) {
      retained += 1;
    } else {
      missingKeys.push(field.key);
    }
  }
  return {
    fixture: groundTruth.fixture,
    fieldsTotal: groundTruth.fields.length,
    fieldsRetained: retained,
    retention: retained / groundTruth.fields.length,
    missingKeys,
  };
}

export interface PayloadScore {
  /** Exact cl100k_base token count of the payload. */
  tokens: number;
  /** Character length of the payload. */
  chars: number;
}

/** Score the size of a payload a library would hand to an LLM. */
export function scorePayload(payload: string): PayloadScore {
  return { tokens: countTokens(payload), chars: payload.length };
}

/**
 * Compression ratio of a tool's payload vs the raw HTML it was derived from.
 * This is the real, measured replacement for the old unverified `15.3x`
 * constant. A ratio > 1 means the tool's payload is smaller than raw HTML.
 */
export function compressionRatio(rawHtml: string, toolPayload: string): number {
  const rawTokens = countTokens(rawHtml);
  const payloadTokens = countTokens(toolPayload);
  if (payloadTokens === 0) {
    return rawTokens === 0 ? 1 : Infinity;
  }
  return rawTokens / payloadTokens;
}

/** One point on the tokens-vs-retention scatter — the upper-left wins. */
export interface EfficiencyPoint {
  library: string;
  fixture: string;
  tokens: number;
  retention: number;
}

/**
 * Build the efficiency point for one (library, fixture) cell. The winner of
 * the axis sits in the upper-left of the scatter: few tokens, high retention.
 */
export function efficiencyPoint(
  library: string,
  groundTruth: GroundTruthSpec,
  extracted: Record<string, string | null | undefined>,
  payload: string,
): EfficiencyPoint {
  return {
    library,
    fixture: groundTruth.fixture,
    tokens: scorePayload(payload).tokens,
    retention: computeRetention(extracted, groundTruth).retention,
  };
}
