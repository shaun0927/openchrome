/**
 * Shared `returnAfterState` chaining option for input tools.
 *
 * Lets a single MCP round-trip carry both the action result and a fresh page
 * snapshot, collapsing the act -> observe ping-pong typical of LLM-driven
 * automation. Default is `'none'`, which preserves byte-identical v1.11.0
 * behaviour.
 *
 * The snapshot is captured by invoking the existing `read_page` handler in
 * process so we never duplicate its formatter, sanitizer, or compression
 * logic. See issue #845 (chrome-devtools-mcp adoption A.2).
 */

import type { Page } from 'puppeteer-core';
import type { MCPContent, MCPResult, ToolContext } from '../../types/mcp';
import { readPageHandlerForReuse } from '../read-page';

export type ReturnAfterState = 'none' | 'ax' | 'dom';

/**
 * JSON-schema fragment merged into every input tool that accepts the option.
 * Centralised so descriptions stay aligned and so a single edit reaches every
 * tool.
 */
export const RETURN_AFTER_STATE_SCHEMA = {
  type: 'string',
  enum: ['none', 'ax', 'dom'] as const,
  description:
    'Optional chaining hint. When "ax" or "dom", the response includes a page snapshot of that mode captured after the post-action wait, removing the need for a follow-up read_page call. Default: "none".',
} as const;

/**
 * Coerce raw `args.returnAfterState` to the canonical enum, defaulting to
 * `'none'` for any unrecognised value (including `undefined`). Defensive so
 * malformed callers cannot trigger a snapshot they did not request.
 */
export function parseReturnAfterState(value: unknown): ReturnAfterState {
  if (value === 'ax' || value === 'dom') return value;
  return 'none';
}

/**
 * Marker key carried on the snapshot content block. The hint engine reads
 * this to detect "the agent already observed page state" and suppress
 * read-page nag rules. Lives on the content block (not on _meta) because
 * `_meta` is dropped by some transports.
 */
export const RETURN_AFTER_STATE_MARKER_PREFIX = '[return_after_state]';

export interface CapturedReturnAfterState {
  mode: 'ax' | 'dom';
  /** read_page text content for the requested mode (snapshot proper). */
  snapshot: string;
  /** unix epoch ms at which the snapshot was captured. */
  capturedAt: number;
  /** Loader id of the main frame at capture time, or empty if unavailable. */
  loaderId: string;
}

/**
 * Capture a fresh page snapshot using the same code path as `read_page`.
 *
 * Returns `null` when capture fails so the caller can degrade gracefully —
 * a missing snapshot is annoying, not fatal, and the action result itself
 * is still useful.
 */
export async function captureReturnAfterState(
  page: Page,
  sessionId: string,
  tabId: string,
  mode: 'ax' | 'dom',
  context?: ToolContext,
): Promise<CapturedReturnAfterState | null> {
  // Best-effort loaderId capture via CDP. Failure is non-fatal — the field
  // exists for trace correlation, not correctness.
  let loaderId = '';
  try {
    const target = (page as unknown as { target: () => { createCDPSession: () => Promise<{ send: (m: string, p?: unknown) => Promise<unknown>; detach: () => Promise<void> }> } }).target();
    const session = await target.createCDPSession();
    try {
      const { frameTree } = (await session.send('Page.getFrameTree')) as {
        frameTree?: { frame?: { loaderId?: string } };
      };
      loaderId = frameTree?.frame?.loaderId ?? '';
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    // ignore — loaderId is optional
  }

  // Reuse read_page's handler verbatim — same formatter, same sanitizer,
  // same compression rules.
  let result: MCPResult;
  try {
    result = await readPageHandlerForReuse(
      sessionId,
      { tabId, mode, includePagination: false },
      context,
    );
  } catch {
    return null;
  }

  if (result.isError || !result.content) return null;

  // Concatenate text blocks — read_page returns a single text block today,
  // but the array shape leaves room for future expansion.
  const snapshot = result.content
    .filter((c): c is MCPContent & { type: 'text'; text: string } =>
      c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n');

  if (!snapshot) return null;

  return {
    mode,
    snapshot,
    capturedAt: Date.now(),
    loaderId,
  };
}

/**
 * Build the MCP content block that carries a captured snapshot. Kept as a
 * dedicated block so callers can append it without disturbing the existing
 * action result text (which the hint engine and trace already pattern-match).
 *
 * The text starts with `RETURN_AFTER_STATE_MARKER_PREFIX` so downstream
 * consumers (hint engine, audit log) can detect "snapshot was inlined" by a
 * cheap substring check on the rendered tool result.
 */
export function formatReturnAfterStateContent(
  state: CapturedReturnAfterState,
): MCPContent {
  const header =
    `${RETURN_AFTER_STATE_MARKER_PREFIX} mode=${state.mode} ` +
    `capturedAt=${state.capturedAt}` +
    (state.loaderId ? ` loaderId=${state.loaderId}` : '');
  return {
    type: 'text',
    text: `${header}\n${state.snapshot}`,
  };
}

/**
 * Convenience: capture and attach the snapshot to the result's structured
 * `state` field per the issue #845 contract. We deliberately do NOT also
 * inline the snapshot as an extra `content` text block — that would double
 * the bytes on the wire (once in the structured field, once in the
 * concatenated text) and defeat the entire point of the option, which is to
 * shave bytes off the act -> observe loop. Callers that only consume
 * `content[].text` can opt out by leaving `returnAfterState: 'none'`.
 *
 * Returns the captured snapshot (or `null` on failure) so callers can
 * inspect it for hint-engine signalling without re-reading `result.state`.
 */
export async function appendReturnAfterState(
  result: MCPResult,
  page: Page,
  sessionId: string,
  tabId: string,
  mode: ReturnAfterState,
  context?: ToolContext,
): Promise<CapturedReturnAfterState | null> {
  if (mode === 'none') return null;
  const captured = await captureReturnAfterState(page, sessionId, tabId, mode, context);
  if (!captured) return null;

  // Surface the structured snapshot at the result root per the contract.
  // `loaderId` is omitted from the wire payload when we couldn't capture
  // one (e.g. CDP failed) so we don't pay the metadata bytes for an empty
  // string. Consumers should treat absent `loaderId` as "unknown".
  const state: {
    mode: 'ax' | 'dom';
    snapshot: string;
    capturedAt: number;
    loaderId?: string;
  } = {
    mode: captured.mode,
    snapshot: captured.snapshot,
    capturedAt: captured.capturedAt,
  };
  if (captured.loaderId) state.loaderId = captured.loaderId;
  result.state = state;
  return captured;
}
