/**
 * Shared types for token-efficiency extractors (#1256).
 *
 * The Token Efficiency axis compares "what each library hands to an LLM" for
 * the same input page. An `Extractor` is the small uniform surface this
 * comparison runs against: feed it the fixture HTML, get back the structured
 * extraction the library would have produced plus the byte-level payload it
 * would have sent.
 *
 * Per Epic #1254 fairness principle #4, every extractor is constructed from
 * the LIBRARY'S documented best-practice extraction. A library that fails to
 * produce a key is honest about it — it returns `null` for that key, which
 * the retention scoring treats as a miss (RUBRIC.md, "Present — the matching
 * rule").
 *
 * Live cells (real Chrome, real Python bridge) are NOT exercised in
 * `--skip-live` mode; they advertise `liveOnly: true` and the matrix runner
 * skips them with an explicit annotation rather than fabricating numbers.
 */

import type { GroundTruthSpec } from '../token-efficiency';

export interface ExtractorResult {
  /**
   * Field-keyed structured extraction. Used as the input to
   * `computeRetention()` — a `null` for a key counts as a miss.
   */
  extracted: Record<string, string | null>;
  /**
   * The byte-level payload the library would have handed to an LLM. Used as
   * the input to `scorePayload()` and `compressionRatio()`. Must be a real
   * string, not a JSON.stringify of `extracted` unless the library actually
   * produces JSON natively (e.g. `query_dom`).
   */
  payload: string;
}

export interface SkippedCell {
  /** True when the extractor was not actually run (e.g. live-only in CI). */
  skipped: true;
  reason: string;
}

export interface RunCell {
  skipped: false;
  result: ExtractorResult;
  /** How many measurements the runner aggregated for this cell. */
  sampleCount: number;
}

export type CellOutcome = SkippedCell | RunCell;

export interface ExtractorContext {
  /** Full fixture HTML — every extractor's input. */
  html: string;
  /** Ground truth — extractors may use it to know which keys to populate. */
  groundTruth: GroundTruthSpec;
  /** Set when `OPENCHROME_BENCH_LIVE=1` — gate for live-only extractors. */
  liveAllowed: boolean;
}

export interface Extractor {
  /** Library tag, e.g. "deterministic-static", "playwright-content". */
  library: string;
  /**
   * Per-library mode label, e.g. "regex-data-field", "cheerio-data-field",
   * "raw-html", "a11y-snapshot", "innerText".
   */
  mode: string;
  /**
   * True when this extractor requires live Chrome / Python / network in
   * addition to the fixture HTML. The matrix runner skips it unless
   * `liveAllowed` is true.
   */
  liveOnly: boolean;
  /**
   * Extract a structured record + an LLM payload. Returns `null` to indicate
   * a skip (the runner then emits a `SkippedCell` instead of a `RunCell`).
   */
  extract(ctx: ExtractorContext): ExtractorResult | null;
}
