/**
 * MCP-replay JSONL formatter (issue #836).
 *
 * Each tool call is captured as a single line of JSON with the shape
 *
 *   { "ts": <ms-epoch>, "tool": <toolName>, "args": <args> }
 *
 * unlike the puppeteer/playwright formatters this is *not* selective —
 * every tool call goes through here, which makes mcp-replay the canonical
 * "what just ran" log. Replay clients can read this file line-by-line and
 * dispatch back through the MCP `tools/call` endpoint to reproduce the
 * exact session.
 */

/** No header / footer — JSONL is line-delimited and self-framing. */
export const MCP_REPLAY_FILE_HEADER = '';
export const MCP_REPLAY_FILE_FOOTER = '';

/**
 * Outcome of a recorded tool call. `success` is the default (back-compat
 * with the original PR); `error` rows additionally carry an optional
 * `errorMessage`. Recorded in the JSONL so replay clients can decide
 * whether to short-circuit on the first failure or keep going.
 *
 * Codex P2 (PR #949): without an outcome field, failure-heavy sessions
 * are impossible to fully reconstruct from JSONL output.
 */
export type McpReplayOutcome = 'success' | 'error';

/** Build one JSONL line (no trailing newline). */
export function formatMcpReplay(
  tool: string,
  args: Record<string, unknown>,
  ts: number = Date.now(),
  outcome: McpReplayOutcome = 'success',
  errorMessage?: string,
): string {
  // Keep `success` rows byte-identical to the v1.11.0 shape (no outcome
  // key) so existing snapshot tests / consumers don't see a diff for the
  // happy path. Only `error` rows add the new fields.
  if (outcome === 'success' && errorMessage === undefined) {
    return JSON.stringify({ ts, tool, args });
  }
  return JSON.stringify({
    ts,
    tool,
    args,
    outcome,
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  });
}
