/**
 * Outcome Contract DSL — assertion vocabulary and evidence shapes.
 *
 * This module is intentionally I/O-free: it defines the data layer only.
 * Live evaluation against a Chromium page is wired in #706 (Contract
 * Runtime); per-assertion evaluators in `./evaluators` operate on a
 * narrow `EvalContext` interface so the data layer stays decoupled from
 * CDP plumbing.
 *
 * Refer to docs/contracts.md for the authoring guide.
 */

export type ComparisonOp = 'eq' | 'gte' | 'lte';

export type NetworkSinceMarker = 'contract_enter' | 'last_tool_call';

export interface UrlAssertion {
  kind: 'url';
  /** JS RegExp source (anchoring is the caller's responsibility). */
  pattern: string;
}

export interface DomTextAssertion {
  kind: 'dom_text';
  /** CSS selector. Defaults to `body` (innerText) when omitted. */
  selector?: string;
  contains: string;
}

export interface DomCountAssertion {
  kind: 'dom_count';
  selector: string;
  op: ComparisonOp;
  value: number;
}

export interface NetworkAssertion {
  kind: 'network';
  /** Substring or RegExp source matched against the request URL. */
  url_pattern: string;
  status_in: number[];
  /**
   * `contract_enter` — entries since `runWithContract` began the pre-check.
   * `last_tool_call` — entries since the most recent MCP tool invocation.
   */
  since: NetworkSinceMarker;
}

export interface ScreenshotClassAssertion {
  kind: 'screenshot_class';
  class_id: string;
  /** Hamming distance over the 64-bit pHash. Range 0-64. */
  distance_max: number;
}

export interface NoDialogAssertion {
  kind: 'no_dialog';
}

/**
 * Vision Q&A assertion (#1432). Asks the host LLM (via the runtime's
 * sampling-backed `imageQa` hook) a question about the most recent
 * screenshot and matches the answer against `expected_pattern` (JS
 * RegExp source). Inconclusive when the runtime does not wire an
 * `imageQa` hook — OpenChrome never calls a model itself.
 */
export interface ImageQaAssertion {
  kind: 'image_qa';
  /** Free-form prompt for the host LLM. */
  question: string;
  /** JS RegExp source matched against the answer text. */
  expected_pattern: string;
}

export interface AndAssertion {
  kind: 'and';
  /** At least one child required. */
  children: Assertion[];
}

export interface OrAssertion {
  kind: 'or';
  /** At least one child required. */
  children: Assertion[];
}

export interface NotAssertion {
  kind: 'not';
  /** Exactly one child. */
  child: Assertion;
}

export type LeafAssertion =
  | UrlAssertion
  | DomTextAssertion
  | DomCountAssertion
  | NetworkAssertion
  | ScreenshotClassAssertion
  | NoDialogAssertion
  | ImageQaAssertion;

export type Assertion = LeafAssertion | AndAssertion | OrAssertion | NotAssertion;

/**
 * Stable shape produced by every evaluator. `assertion_kind` (not `kind`)
 * avoids the field-name collision with the assertion DSL when both shapes
 * are merged into one record by the runtime.
 */
export interface Evidence {
  passed: boolean;
  assertion_kind: Assertion['kind'];
  details: Record<string, unknown>;
  trace_ref?: { trace_id: string; from_ts: number; to_ts: number };
  screenshot_path?: string;
}

export interface EvaluationResult {
  passed: boolean;
  evidence: Evidence;
}
