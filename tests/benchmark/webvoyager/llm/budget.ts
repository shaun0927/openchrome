/**
 * Hard budget caps for the WebVoyager benchmark.
 *
 * These caps protect the wallet and bound worst-case wall-clock: an LLM
 * adapter MUST honour them; the runner enforces `max_tool_iterations` and
 * the adapter is responsible for `max_tokens` per turn and the USD ceiling.
 *
 * The caps are not configurable per-task because the goal is a comparable
 * single number across the suite — letting tasks raise their own ceiling
 * would silently inflate cost and skew comparison.
 */

export interface BudgetCaps {
  /** Maximum tokens per single LLM turn. */
  max_tokens: number;
  /** Maximum tool calls the adapter may make in a single task. */
  max_tool_iterations: number;
  /** USD ceiling per task; adapter must abort with BUDGET_EXCEEDED if hit. */
  max_usd_per_task: number;
}

export const WEBVOYAGER_BUDGET: BudgetCaps = Object.freeze({
  max_tokens: 4096,
  max_tool_iterations: 50,
  max_usd_per_task: 0.5,
});
