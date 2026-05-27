/**
 * pathMetaFor — additive `meta.path_taken` builder for tool result payloads
 * (A3-PR2 of #1359).
 *
 * Reads the most-recent BrowserRouter decision recorded by SessionManager
 * (`getLastRouting`) and produces an object that callers spread into their
 * JSON response:
 *
 *   const meta = pathMetaFor(sessionManager, tabId);
 *   const text = JSON.stringify({ action: 'navigate', ..., ...meta });
 *
 * Returns `{}` when no routing decision is available (hybrid mode off,
 * target unknown, or the entry has been evicted). This keeps the field
 * strictly *additive* — existing host integrations see no change unless
 * they explicitly look for `meta`.
 *
 * Per #1359 §Pillar C (facts before decisions): the host reads
 * `meta.path_taken` to learn which backend served the call and decides
 * what to do with it (token-cost optimization, retry policy, evidence
 * enrichment). No threshold is encoded in the helper.
 */

import type { SessionManager } from '../../session-manager';
import type { BrowserBackend, RouteReason } from '../../types/browser-backend';

export interface PathMetaFields {
  path_taken: RouteReason;
  backend: BrowserBackend;
  /** Only present when `fallback === true`. */
  fallback_reason?: RouteReason;
}

/**
 * Build the `meta` field to spread into a tool result payload.
 *
 * Returns `{}` when no routing decision is available — keeps the meta
 * key absent rather than emitting `{ meta: undefined }`, so the response
 * surface is strictly additive and existing snapshot tests stay stable.
 */
export function pathMetaFor(
  sessionManager: SessionManager,
  targetId: string | undefined,
): { meta: PathMetaFields } | Record<string, never> {
  if (!targetId) return {};
  const getLastRouting = (sessionManager as { getLastRouting?: unknown }).getLastRouting;
  if (typeof getLastRouting !== 'function') return {};
  const routing = getLastRouting.call(sessionManager, targetId) as ReturnType<SessionManager['getLastRouting']>;
  if (!routing) return {};
  const meta: PathMetaFields = {
    path_taken: routing.path_taken,
    backend: routing.backend,
  };
  if (routing.fallback) {
    // `lp-unhealthy` is the only reason emitted with fallback=true today,
    // but we copy `path_taken` here so the field carries a deterministic
    // discriminator forever — adding a new fallback reason in the router
    // surfaces here automatically.
    meta.fallback_reason = routing.path_taken;
  }
  return { meta };
}
