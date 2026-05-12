/**
 * Human-readable banner for a handoff exchange (Phase 3, issue #793).
 *
 * When a token is created or redeemed, the host surfaces a banner to the
 * operator so the transfer is auditable in plain language alongside the
 * structured JSON. The banner deliberately omits the raw token — copying
 * the token belongs in a separate, copy-friendly field handled by the
 * surrounding UI / tool result.
 *
 * Wired into the `oc_pilot_handoff_create` and `oc_pilot_handoff_redeem`
 * MCP tools (see `./tool.ts`).
 */

export interface HandoffBannerPayload {
  /** Browser session being transferred. */
  sessionId: string;
  /** Caller-supplied scope label. */
  scope: string;
  /** Wall-clock ms (epoch) at which the token becomes invalid. */
  expiresAt: number;
  /** Optional clock override for deterministic tests. */
  now?: () => number;
}

/**
 * Render a single-screen banner that describes the handoff. Multi-line
 * plain text — safe to print to stderr or embed inside an MCP text
 * content block. Never includes the raw token to avoid log leakage.
 */
export function renderHandoffBanner(payload: HandoffBannerPayload): string {
  const now = (payload.now ?? Date.now)();
  const remainingMs = Math.max(0, payload.expiresAt - now);
  const expiresIso = new Date(payload.expiresAt).toISOString();
  return [
    '== openchrome handoff ==',
    `session: ${payload.sessionId}`,
    `scope:   ${payload.scope}`,
    `expires: ${expiresIso} (in ${formatDuration(remainingMs)})`,
    'token:   <redacted — fetch via tool result>',
  ].join('\n');
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h${remMin}m`;
}
