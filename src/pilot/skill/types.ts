/**
 * Pilot-tier skill graph executor — public types.
 *
 * Issue #820 (blocking #717). The executor is a pure decision function:
 * given the current page state hash plus a host-supplied candidate action
 * list, it consults the per-domain skill graph (src/core/skill/storage) and
 * recommends one of three outcomes — fast-forward (we are already at a
 * state the candidate has historically led to), pick a specific candidate
 * (graph evidence is confident enough), or defer to the host (cold graph
 * or low confidence). Per the portability-harness contract clause P4,
 * the executor returns a recommendation only — it never invokes MCP tools
 * and never mutates the page.
 *
 * The state-hashing primitive that produces `currentStateHash` is a
 * separate concern (will land in a follow-up). The executor accepts a
 * pre-computed hash so this module stays a pure function of its inputs.
 */

export interface ExecutorAction {
  /** Action kind, e.g. `click`, `type`, `navigate`. */
  kind: string;
  /** Canonicalised arg representation used for graph identity. */
  argsNorm: string;
}

export type ExecutorDecisionKind =
  | 'already_at_target'
  | 'recommended'
  | 'host_decides';

export interface ExecutorInput {
  /** Domain label used to scope the per-domain graph file. Required. */
  domain: string;
  /** Pre-computed hash of the current page state. Required. */
  currentStateHash: string;
  /** Ordered candidate actions the host is considering. Required, non-empty. */
  candidateActions: readonly ExecutorAction[];
}

export interface ExecutorDecision {
  kind: ExecutorDecisionKind;
  /**
   * Set when `kind === 'already_at_target'` — the state hash we have
   * fast-forwarded to (equals the input `currentStateHash`). The host can
   * use this as a signal to advance to the next planned step in its
   * sequence without invoking any MCP tool for the matched candidate.
   */
  skipUntil?: string;
  /**
   * Set when `kind === 'recommended'` — the candidate the graph backs as
   * the best next action from `currentStateHash`.
   */
  recommended?: ExecutorAction;
  /** Short human-readable explanation, included in audit and debug logs. */
  reason: string;
}
