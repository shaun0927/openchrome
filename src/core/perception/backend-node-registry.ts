/**
 * BackendNodeRegistry — stable opaque uids for CDP backend nodes (#844).
 *
 * Adopted from the chrome-devtools-mcp `uniqueBackendNodeIdToMcpId` map
 * (Apache-2.0). The registry maps `(loaderId, backendNodeId)` to an opaque
 * uid (`n_<n>`) and reuses the same uid across successive snapshots of the
 * same DOM node so agents do not need to re-issue `read_page` between every
 * `interact`. On navigation the registry is rotated: every uid minted under
 * a previous loaderId is evicted, and stale uid resolutions are reported
 * structurally instead of via a generic stale-ref panic.
 *
 * Invariants (verbatim from issue #844):
 *   1. Within one loaderId, the same (loaderId, backendNodeId) always
 *      returns the same uid.
 *   2. On navigation (loaderId change), all uids minted under the previous
 *      loaderId are evicted.
 *   3. A uid may be resolved back to its backendNodeId for at most one
 *      navigation epoch.
 *   4. Registry is keyed per CDP target (one instance per puppeteer-core
 *      `Page`); not shared across tabs. Lifetime is tied to the `Page`
 *      lifetime — destroyed when the tab closes.
 *
 * The uid format is opaque: `n_<positive-integer>`. It deliberately does
 * NOT echo the underlying backendNodeId so the wire format stays free of
 * incidental Chrome-internal metadata.
 *
 * This module is core-tier (`src/core/perception/`) and ships unflagged.
 * The companion runtime feature flag `OPENCHROME_NODE_REF` (default on) is
 * read at the *call sites* via `isCoreFeatureEnabled` in
 * `src/harness/flags.ts`; the registry itself does not check the flag so it
 * remains a deterministic, side-effect-free data structure.
 */

import type { Page } from 'puppeteer-core';

export interface StableUid {
  /** Opaque uid (e.g. "n_42"). Never echoes backendNodeId. */
  uid: string;
  backendNodeId: number;
  loaderId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface BackendNodeRegistry {
  /** Returns the existing uid for (loaderId, backendNodeId) or mints a new one. */
  get(loaderId: string, backendNodeId: number): StableUid;
  /** Marks all uids whose loaderId !== current as stale and prunes them. */
  rotate(currentLoaderId: string): { evicted: number; kept: number };
  /** Resolves a uid back to a backendNodeId; returns null if evicted. */
  resolve(uid: string): { loaderId: string; backendNodeId: number } | null;
  /** Pure metric. */
  size(): number;
}

interface InternalEntry extends StableUid {
  /** Composite map key: `${loaderId}_${backendNodeId}`. */
  compositeKey: string;
}

/**
 * Default in-memory implementation. One instance per `Page`.
 *
 * Internal indexes:
 *   - `byComposite`: `${loaderId}_${backendNodeId}` -> entry, used by `get`.
 *   - `byUid`: `uid` -> entry, used by `resolve`.
 *   - `byLoaderId`: `loaderId` -> entries, used by `rotate`.
 *
 * All indexes hold the same `InternalEntry` references. `rotate()` walks loader
 * buckets rather than scanning every composite key repeatedly, so bulk
 * snapshot/navigation churn remains linear in the number of evicted entries.
 */
export class InMemoryBackendNodeRegistry implements BackendNodeRegistry {
  private readonly byComposite = new Map<string, InternalEntry>();
  private readonly byUid = new Map<string, InternalEntry>();
  private readonly byLoaderId = new Map<string, Set<InternalEntry>>();
  private counter = 0;

  /** Visible for tests — do not call from production code. */
  readonly UID_PREFIX = 'n_';

  private compositeKey(loaderId: string, backendNodeId: number): string {
    return `${loaderId}_${backendNodeId}`;
  }

  get(loaderId: string, backendNodeId: number): StableUid {
    if (!loaderId || typeof loaderId !== 'string') {
      throw new TypeError('BackendNodeRegistry.get: loaderId must be a non-empty string');
    }
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
      throw new TypeError(
        `BackendNodeRegistry.get: backendNodeId must be a positive integer (got ${backendNodeId})`,
      );
    }
    const key = this.compositeKey(loaderId, backendNodeId);
    const existing = this.byComposite.get(key);
    const now = Date.now();
    if (existing) {
      existing.lastSeenAt = now;
      // Return a defensive copy so callers cannot mutate registry state.
      return {
        uid: existing.uid,
        backendNodeId: existing.backendNodeId,
        loaderId: existing.loaderId,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: existing.lastSeenAt,
      };
    }
    this.counter += 1;
    const uid = `${this.UID_PREFIX}${this.counter}`;
    const entry: InternalEntry = {
      compositeKey: key,
      uid,
      backendNodeId,
      loaderId,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.byComposite.set(key, entry);
    this.byUid.set(uid, entry);
    let loaderBucket = this.byLoaderId.get(loaderId);
    if (!loaderBucket) {
      loaderBucket = new Set<InternalEntry>();
      this.byLoaderId.set(loaderId, loaderBucket);
    }
    loaderBucket.add(entry);
    return {
      uid: entry.uid,
      backendNodeId: entry.backendNodeId,
      loaderId: entry.loaderId,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    };
  }

  rotate(currentLoaderId: string): { evicted: number; kept: number } {
    if (!currentLoaderId || typeof currentLoaderId !== 'string') {
      throw new TypeError(
        'BackendNodeRegistry.rotate: currentLoaderId must be a non-empty string',
      );
    }
    const kept = this.byLoaderId.get(currentLoaderId)?.size ?? 0;
    let evicted = 0;
    for (const [loaderId, entries] of Array.from(this.byLoaderId.entries())) {
      if (loaderId === currentLoaderId) continue;
      for (const entry of entries) {
        this.byComposite.delete(entry.compositeKey);
        this.byUid.delete(entry.uid);
        evicted += 1;
      }
      this.byLoaderId.delete(loaderId);
    }
    return { evicted, kept };
  }

  resolve(uid: string): { loaderId: string; backendNodeId: number } | null {
    const entry = this.byUid.get(uid);
    if (!entry) return null;
    return { loaderId: entry.loaderId, backendNodeId: entry.backendNodeId };
  }

  size(): number {
    return this.byUid.size;
  }
}

/**
 * Per-Page registry accessor.
 *
 * Uses a process-global WeakMap so the registry is garbage-collected when
 * its `Page` is closed (per invariant #4). The first access also installs
 * a `framenavigated` listener that calls `rotate(currentLoaderId)` on
 * main-frame navigations.
 */
const REGISTRIES = new WeakMap<Page, InMemoryBackendNodeRegistry>();
const NAV_HOOKED = new WeakSet<Page>();

/**
 * Pure helper: extract a loaderId from a puppeteer-core Frame using the
 * lowest-friction surface available. puppeteer-core's `Frame` exposes a
 * non-public `_id` (frameId) but no loaderId. The CDP `Frame.loaderId` is
 * what we want; we fall back to the frame's `_id` when CDP is not in scope
 * (e.g. unit tests use a mock).
 *
 * Callers that need the *real* current loaderId should pass it explicitly
 * to `rotate()`; this helper is a best-effort fallback for the navigation
 * listener that does not have CDP access in scope.
 */
function loaderIdFromFrameNavigatedEvent(frame: { _id?: string; loaderId?: string }): string {
  // Some puppeteer versions surface `loaderId` on the Frame object after a
  // navigation event; when present prefer it.
  if (typeof frame.loaderId === 'string' && frame.loaderId.length > 0) {
    return frame.loaderId;
  }
  if (typeof frame._id === 'string' && frame._id.length > 0) {
    return frame._id;
  }
  // Last-ditch deterministic value so the registry rotate() still removes
  // entries from the previous loaderId.
  return 'unknown-loader';
}

export function getBackendNodeRegistry(page: Page): InMemoryBackendNodeRegistry {
  let reg = REGISTRIES.get(page);
  if (!reg) {
    reg = new InMemoryBackendNodeRegistry();
    REGISTRIES.set(page, reg);
  }
  if (!NAV_HOOKED.has(page)) {
    NAV_HOOKED.add(page);
    try {
      // Rotate when the main frame navigates. Sub-frame navigations do not
      // invalidate root-document backendNodeIds, so they are skipped.
      page.on('framenavigated', (frame) => {
        try {
          const mainFrame = page.mainFrame?.();
          if (!mainFrame || frame !== mainFrame) return;
          const loaderId = loaderIdFromFrameNavigatedEvent(
            frame as unknown as { _id?: string; loaderId?: string },
          );
          reg!.rotate(loaderId);
        } catch (err) {
          // Never let registry bookkeeping take the page event loop down.
          // Use console.error per CLAUDE.md (stdout carries MCP JSON-RPC).
          console.error(
            '[backend-node-registry] framenavigated rotate failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    } catch {
      // page may not support .on() in test mocks; ignore — callers can
      // rotate explicitly.
    }
  }
  return reg;
}

/**
 * Test-only escape hatch: drop the per-Page registry. Production code should
 * never call this; it exists so suite teardown can reset state.
 */
export function _resetBackendNodeRegistryForTests(page: Page): void {
  REGISTRIES.delete(page);
  NAV_HOOKED.delete(page);
}
