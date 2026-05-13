/**
 * Tool-side helpers for the backend-node uid contract (#844).
 *
 * These wrap the per-Page `BackendNodeRegistry` with the runtime feature-flag
 * check (`OPENCHROME_NODE_REF`, default ON) and the CDP plumbing needed to
 * resolve the current loaderId. Tools call:
 *
 *   - `mintNodeRef(page, cdp, backendNodeId)` from `read_page`/`query_dom`/
 *     `inspect`/`interact` to obtain a uid (or `null` when off).
 *   - `resolveNodeRef(page, uid)` from `interact` to validate a caller-supplied
 *     uid before the action.
 *   - `formatNodeRefToken(uid)` to render the standard `nodeRef=<uid|null>`
 *     token in tool text payloads (P2 byte-stable when off — token literally
 *     becomes `nodeRef=null`).
 *
 * Keeping these helpers out of the tools' hot loop has two benefits:
 *   1. The flag check and CDP fetch are centralised, so an audit can verify
 *      the contract holds across every tool with one read.
 *   2. The tools themselves stay independent of perception internals.
 */

import type { Page } from 'puppeteer-core';

import { isCoreFeatureEnabled } from '../../harness/flags';
import { getBackendNodeRegistry } from './backend-node-registry';

/** Sentinel runtime payload value emitted when the contract is off. */
export const NODE_REF_OFF: null = null;

/** Returns true iff the OPENCHROME_NODE_REF flag is enabled (default ON). */
export function isNodeRefEnabled(): boolean {
  return isCoreFeatureEnabled('OPENCHROME_NODE_REF', true);
}

/**
 * Minimal CDP send shape used by the tool dispatchers. Kept narrow so this
 * module does not depend on the full `CDPClient` class signature.
 */
export interface CdpSendShape {
  send<T = unknown>(page: Page, method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Fetch the current main-frame loaderId via CDP `Page.getFrameTree`. Throws
 * if the call fails — callers should treat that as a "no-uid" condition and
 * emit `nodeRef=null` rather than failing the tool call.
 */
export async function getCurrentLoaderId(page: Page, cdp: CdpSendShape): Promise<string> {
  const result = await cdp.send<{
    frameTree: { frame: { id: string; loaderId?: string } };
  }>(page, 'Page.getFrameTree');
  const frame = result?.frameTree?.frame;
  if (!frame) {
    throw new Error('getCurrentLoaderId: Page.getFrameTree returned no frame');
  }
  // Some Chrome versions return the loaderId on the frame envelope; when
  // it's missing, fall back to the frame id (deterministic per-page) so the
  // registry still partitions snapshots by navigation epoch.
  return typeof frame.loaderId === 'string' && frame.loaderId.length > 0
    ? frame.loaderId
    : frame.id;
}

/**
 * Mint (or reuse) a uid for `(currentLoaderId, backendNodeId)`. Returns
 * `null` when the feature flag is off (P2 runtime parity with v1.11.0).
 *
 * Failures of the CDP loaderId fetch are caught and surfaced as `null` —
 * the registry is a hint, not a correctness boundary, so a transient CDP
 * failure must never break `read_page`.
 */
export async function mintNodeRef(
  page: Page,
  cdp: CdpSendShape,
  backendNodeId: number,
): Promise<string | null> {
  if (!isNodeRefEnabled()) return NODE_REF_OFF;
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return NODE_REF_OFF;
  let loaderId: string;
  try {
    loaderId = await getCurrentLoaderId(page, cdp);
  } catch (err) {
    // Use console.error per CLAUDE.md (stdout carries MCP JSON-RPC).
    console.error(
      '[node-ref] getCurrentLoaderId failed, emitting null uid:',
      err instanceof Error ? err.message : String(err),
    );
    return NODE_REF_OFF;
  }
  // Rotate the registry to the current loaderId before minting. This is
  // cheap when no rotation is needed (returns evicted=0) and guarantees
  // that uids minted now never coexist with stale uids from a prior
  // navigation epoch.
  const registry = getBackendNodeRegistry(page);
  registry.rotate(loaderId);
  return registry.get(loaderId, backendNodeId).uid;
}

/**
 * Synchronous variant of `mintNodeRef` for hot-path code that already
 * holds a known-good loaderId. Skips the CDP round-trip.
 */
export function mintNodeRefSync(
  page: Page,
  loaderId: string,
  backendNodeId: number,
): string | null {
  if (!isNodeRefEnabled()) return NODE_REF_OFF;
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return NODE_REF_OFF;
  if (typeof loaderId !== 'string' || loaderId.length === 0) return NODE_REF_OFF;
  const registry = getBackendNodeRegistry(page);
  registry.rotate(loaderId);
  return registry.get(loaderId, backendNodeId).uid;
}

/**
 * Resolve a caller-supplied uid to its registered `(loaderId, backendNodeId)`.
 * Returns null when:
 *   - the feature flag is off (caller should not have a uid in the first place);
 *   - the uid was never minted on this page;
 *   - the uid was evicted by a navigation since being minted.
 */
export function resolveNodeRef(
  page: Page,
  uid: string,
): { loaderId: string; backendNodeId: number } | null {
  if (!isNodeRefEnabled()) return null;
  if (typeof uid !== 'string' || uid.length === 0) return null;
  const registry = getBackendNodeRegistry(page);
  return registry.resolve(uid);
}

/**
 * Render the standard `nodeRef=<uid|null>` token used in tool text payloads.
 * P2 parity: when the flag is off the token still appears in the output,
 * with the literal value `null`. Replaying a v1.11.0 trace against the off
 * branch yields byte-identical tokens (the field always exists in the same
 * position; only the value changes).
 */
export function formatNodeRefToken(uid: string | null): string {
  return `nodeRef=${uid ?? 'null'}`;
}

/**
 * Build the structured `uid_evicted` error payload returned by `interact`
 * when a caller passes a uid that the registry no longer knows about.
 *
 * The format is intentionally machine-parseable: starts with the literal
 * `uid_evicted:`, contains a JSON object with `uid`, `currentLoaderId`,
 * and a hint message. The hint engine's `error-recovery` rule recognises
 * this prefix and suppresses the generic stale-ref hint (#844 issue
 * acceptance criteria).
 */
export function formatUidEvictedError(uid: string, currentLoaderId: string): string {
  return `uid_evicted: ${JSON.stringify({
    uid,
    currentLoaderId,
    hint: 'The DOM node behind this uid was evicted by a navigation. Re-issue read_page/query_dom/inspect to mint a fresh uid.',
  })}`;
}
