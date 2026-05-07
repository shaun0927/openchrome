/**
 * Outcome Contract DSL — assertion types + evidence shape.
 *
 * The DSL is intentionally JSON-first so an LLM can author it via tool
 * calls. Each `Assertion` evaluates to an `Evidence` envelope; the
 * runtime (PR-11) stitches `Evidence` records into the final
 * TransactionRecord.
 *
 * Per #705 v2:
 *   - `not` takes a single `child` (not an array). For "none of these"
 *     compose `{kind:"and", children:[{kind:"not",child:A}, ...]}`.
 *   - `op` uses string enums (`"eq" | "gte" | "lte"`) — not JSON token
 *     operators like `==`.
 *   - `dom_text` default selector is `"body"`; matches `innerText`
 *     (visible text only).
 *   - `screenshot_class.distance_max` is **Hamming distance over a
 *     64-bit perceptual hash** (range 0-64) — defined here for #705's
 *     PR-10 slice.
 *   - `network.since` is `"contract_enter" | "last_tool_call"`:
 *       contract_enter  = ts when runWithContract begins pre-check
 *       last_tool_call  = ts of most recent MCP tool invocation.
 */

export type Assertion =
  | { kind: 'url'; pattern: string /* JS RegExp source, anchored on caller */ }
  | { kind: 'dom_text'; selector?: string /* default: "body" */; contains: string }
  | { kind: 'dom_count'; selector: string; op: DomCountOp; value: number }
  | { kind: 'no_dialog' }
  | {
      kind: 'network';
      url_pattern: string;
      status_in: number[];
      since: NetworkSinceMode;
    }
  | {
      kind: 'screenshot_class';
      class_id: string;
      distance_max: number /* Hamming distance 0-64 over 64-bit pHash */;
    }
  | { kind: 'and'; children: Assertion[] /* len ≥ 1 */ }
  | { kind: 'or'; children: Assertion[] /* len ≥ 1 */ }
  | { kind: 'not'; child: Assertion /* exactly one */ };

export type DomCountOp = 'eq' | 'gte' | 'lte';
export type NetworkSinceMode = 'contract_enter' | 'last_tool_call';

/** Stable list of all primitive (non-composite) assertion kinds. */
export const PRIMITIVE_ASSERTION_KINDS = [
  'url',
  'dom_text',
  'dom_count',
  'no_dialog',
  'network',
  'screenshot_class',
] as const;
export type PrimitiveAssertionKind = (typeof PRIMITIVE_ASSERTION_KINDS)[number];

export const COMPOSITE_ASSERTION_KINDS = ['and', 'or', 'not'] as const;
export type CompositeAssertionKind = (typeof COMPOSITE_ASSERTION_KINDS)[number];

export type AssertionKind = PrimitiveAssertionKind | CompositeAssertionKind;

/**
 * Result envelope produced by the evaluator. `assertion_kind` is named
 * with an underscore (instead of `kind`) so `Evidence` can be embedded
 * in larger JSON without shadowing a parent's `kind` field.
 */
export interface Evidence {
  passed: boolean;
  assertion_kind: AssertionKind;
  details: Record<string, unknown>;
  /** Optional pointer into a recorded trace slice (#704). */
  trace_ref?: { trace_id: string; from_ts: number; to_ts: number };
  /** Optional pointer to a screenshot file backing this evidence. */
  screenshot_path?: string;
  /** When this Evidence wraps composite child evidence (and/or/not), the
   *  recursive structure preserved here so a debugger can drill in. */
  children?: Evidence[];
}
