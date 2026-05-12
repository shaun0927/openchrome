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

/** Build one JSONL line (no trailing newline). */
export function formatMcpReplay(
  tool: string,
  args: Record<string, unknown>,
  ts: number = Date.now(),
): string {
  return JSON.stringify({ ts, tool, args });
}
