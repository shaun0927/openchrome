/**
 * Host-side wiring for the snapshot cache (#879).
 *
 * The cache module (`src/core/perception/snapshot-cache.ts`) is pure JS by
 * design — it never imports puppeteer-core or any CDP type. Tools call
 * into this helper, which:
 *
 *   1. Resolves the active CDP target id (the cache scope) from a page.
 *   2. Resolves the active frame id and viewport rect.
 *   3. Subscribes to `DOM.documentUpdated`, `Page.frameNavigated`, and
 *      `Page.frameResized` on the target once per CDP session so a single
 *      event stream fans out to the snapshot cache without standing up a
 *      second listener registry — mirroring the precedent established by
 *      `src/core/perception/cache.ts` (see its module docstring).
 *
 * Read tools call `lookupOrSet(...)`. Mutating tools call
 * `markFrameDirty(page)` immediately before their successful return so
 * any later read in the same call chain sees a miss. The flag-gating
 * helper (`isSnapshotCacheEnabled`) makes the kill-switch opt-out cheap.
 */

import type { Page } from 'puppeteer-core';
import type { ToolContext } from '../types/mcp';
import { isCoreFeatureEnabled } from '../harness/flags';
import {
  getSnapshotCacheForTarget,
  disposeSnapshotCacheForTarget,
  type SnapshotCache,
  type SnapshotCacheHit,
  type SnapshotCacheKey,
  type SnapshotKind,
  type SnapshotViewportRect,
} from '../core/perception/snapshot-cache';
import { getTargetId } from './puppeteer-helpers';

const FLAG_ENV_VAR = 'OPENCHROME_SNAPSHOT_CACHE';

/**
 * Honor the env kill-switch.
 *
 * **1.12 default: OFF (opt-in).** The cache layer is implemented and unit-
 * tested (snapshot-cache.test.ts, params-hash.test.ts — 36 cases) but the
 * P2 byte-parity regression test (`OPENCHROME_SNAPSHOT_CACHE=0` vs default
 * → response byte-identical to v1.11) is not yet in place. Until that gate
 * lands, default ON would risk a silent 1.11 → 1.12 response-shape drift,
 * violating the Portability-Harness Contract P2.
 *
 * Operators who want to evaluate the cache during 1.12 can opt in with
 * `OPENCHROME_SNAPSHOT_CACHE=1`. The flip back to default ON is tracked in
 * the follow-up issue once the parity test lands.
 */
export function isSnapshotCacheEnabled(): boolean {
  return isCoreFeatureEnabled(FLAG_ENV_VAR, false);
}

interface PageInternals {
  target(): { _targetId?: string };
  mainFrame?: () => { _id?: string; id?: string; url?: () => string };
  viewport?: () => { width?: number; height?: number; deviceScaleFactor?: number } | null;
}

/** Resolve the page's CDP target id; null when puppeteer's internals shift. */
function targetIdOf(page: Page): string | null {
  try {
    const id = getTargetId((page as unknown as PageInternals).target() as never);
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Resolve the page's main frame id, falling back to the target id. */
function mainFrameId(page: Page): string {
  try {
    const mf = (page as unknown as PageInternals).mainFrame?.();
    const fid = mf?._id ?? mf?.id;
    if (typeof fid === 'string' && fid.length > 0) return fid;
  } catch {
    /* fall through */
  }
  return targetIdOf(page) ?? '__unknown_frame__';
}

function currentViewport(page: Page): SnapshotViewportRect {
  try {
    const vp = (page as unknown as PageInternals).viewport?.();
    if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
      return {
        w: vp.width,
        h: vp.height,
        dpr: typeof vp.deviceScaleFactor === 'number' ? vp.deviceScaleFactor : 1,
      };
    }
  } catch {
    /* fall through */
  }
  return { w: 0, h: 0, dpr: 1 };
}

/**
 * Get the per-target snapshot cache instance and lazily attach CDP
 * eviction subscribers the first time we touch this target.
 */
export function getCacheForPage(page: Page): SnapshotCache | null {
  const targetId = targetIdOf(page);
  if (!targetId) return null;
  const cache = getSnapshotCacheForTarget(targetId);
  attachEvictionSubscribersOnce(page, targetId, cache);
  return cache;
}

/**
 * Build a cache key whose epoch matches the cache's view of the frame.
 * Returns null when the kill-switch is disabled or the page lacks a
 * resolvable target id.
 */
export interface BuildKeyParams {
  kind: SnapshotKind;
  paramsHash: string;
}

export function buildKey(
  page: Page,
  params: BuildKeyParams,
): { cache: SnapshotCache; key: SnapshotCacheKey } | null {
  if (!isSnapshotCacheEnabled()) return null;
  const cache = getCacheForPage(page);
  if (!cache) return null;
  const frameId = mainFrameId(page);
  const viewportRect = currentViewport(page);
  const key = cache.buildKey({
    kind: params.kind,
    frameId,
    viewportRect,
    paramsHash: params.paramsHash,
  });
  return { cache, key };
}

/**
 * `read_page` / `find` / `query_dom` cache helper.
 *
 * On a hit, `recompute` is never invoked and the cached value is
 * returned alongside `{ hit: true, age_ms, kind }`. On a miss, the
 * caller's `recompute()` runs and (when `shouldCache(value)` is true)
 * the fresh value is stored before being returned. The kill-switch
 * short-circuits straight to `recompute`.
 *
 * `shouldCache` defaults to "always cache" — tools that need to opt
 * out of caching for error responses pass an explicit predicate.
 */
export interface LookupResult<T> {
  value: T;
  hit: boolean;
  age_ms?: number;
}

function cloneCachedValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function lookupOrSet<T>(
  page: Page,
  params: BuildKeyParams,
  recompute: () => Promise<T>,
  shouldCache: (value: T) => boolean = () => true,
): Promise<LookupResult<T>> {
  const built = buildKey(page, params);
  if (!built) {
    const value = await recompute();
    return { value, hit: false };
  }
  const hit = built.cache.get<T>(built.key) as SnapshotCacheHit<T> | null;
  if (hit) {
    return { value: cloneCachedValue(hit.value), hit: true, age_ms: hit.age_ms };
  }
  const fresh = await recompute();
  if (shouldCache(fresh)) {
    built.cache.set(built.key, cloneCachedValue(fresh));
  }
  return { value: fresh, hit: false };
}

/**
 * Bump the active frame's epoch. Mutating tools call this immediately
 * before emitting a successful response, so any later read in the same
 * call chain forces a recompute.
 */
export function markFrameDirty(page: Page): void {
  if (!isSnapshotCacheEnabled()) return;
  const cache = getCacheForPage(page);
  if (!cache) return;
  cache.markFrameDirty(mainFrameId(page));
}

/**
 * Resolve the page bound to `(sessionId, tabId)` and bump the active
 * frame's epoch. No-op when the page cannot be resolved. Mutating tool
 * wrappers (`wrapMutatingHandler`) use this so the body's surface stays
 * untouched.
 */
async function markFrameDirtyForTab(
  sessionId: string,
  tabId: string | undefined,
  getPage: (sessionId: string, tabId?: string) => Promise<Page | null>,
): Promise<void> {
  if (!isSnapshotCacheEnabled()) return;
  if (!tabId) return;
  try {
    const page = await getPage(sessionId, tabId);
    if (page) markFrameDirty(page);
  } catch {
    /* best-effort */
  }
}

/**
 * Wrap a mutating tool handler so the snapshot cache for the affected
 * frame is invalidated immediately after a successful response. Error
 * responses leave the cache untouched: a transient error must not
 * silently invalidate state the caller may still depend on.
 *
 * `getPage` mirrors `SessionManager.getPage` — kept as a parameter so
 * unit tests can stub it without pulling in the session-manager graph.
 */
export interface MutatingHandlerLike<R> {
  (sessionId: string, args: Record<string, unknown>, context?: ToolContext): Promise<R>;
}

export interface MaybeErrorResult {
  isError?: boolean;
}

function tabIdsFromArgs(args: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  if (typeof args.tabId === 'string' && args.tabId.length > 0) ids.add(args.tabId);
  if (Array.isArray(args.tabIds)) {
    for (const id of args.tabIds) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return Array.from(ids);
}

export function wrapMutatingHandler<R extends MaybeErrorResult>(
  handler: MutatingHandlerLike<R>,
  getPage: (sessionId: string, tabId?: string) => Promise<Page | null>,
): MutatingHandlerLike<R> {
  return async (sessionId, args, context) => {
    try {
      return await handler(sessionId, args, context);
    } finally {
      // Mutators can change page state before returning an error (for example,
      // form fill followed by submit/login verification failure). Invalidate on
      // every completion path so later cached reads cannot observe the pre-call
      // epoch after a partial mutation.
      for (const tabId of tabIdsFromArgs(args)) {
        await markFrameDirtyForTab(sessionId, tabId, getPage);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// CDP subscriber wiring (decoupled from cache.ts, host-side only)
// ---------------------------------------------------------------------------

const ATTACHED = new WeakSet<object>();

interface CDPCapablePage {
  target(): { createCDPSession?: () => Promise<unknown> };
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface CDPSessionLike {
  send: (method: string, params?: unknown) => Promise<unknown>;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  detach?: () => Promise<unknown>;
}

function attachEvictionSubscribersOnce(
  page: Page,
  targetId: string,
  cache: SnapshotCache,
): void {
  // Use the page object as the WeakSet key — one subscription per page
  // instance. Repeated calls (the normal case for every tool call) are
  // O(1) no-ops.
  const pageKey = page as unknown as object;
  if (ATTACHED.has(pageKey)) return;
  ATTACHED.add(pageKey);

  // Best-effort attach; if puppeteer's internals shift we still serve
  // cache hits, but eviction relies on explicit `markFrameDirty` calls
  // from mutating tools. The kill-switch byte-parity test pins that we
  // never serve a stale value in that case (the epoch bump from
  // mutating calls remains authoritative).
  void (async () => {
    try {
      const capable = page as unknown as CDPCapablePage;
      const target = capable.target?.();
      if (!target || typeof target.createCDPSession !== 'function') {
        ATTACHED.delete(pageKey);
        return;
      }
      let session: CDPSessionLike | null = null;
      const closePage = capable.once?.bind(capable);
      closePage?.('close', () => {
        void session?.detach?.().catch(() => undefined);
        disposeSnapshotCacheForTarget(targetId);
      });

      session = (await target.createCDPSession()) as CDPSessionLike;

      // Subscribe to relevant CDP domains. Errors enabling are non-fatal.
      await session.send('DOM.enable').catch(() => undefined);
      await session.send('Page.enable').catch(() => undefined);

      const handleDocUpdated = (): void => {
        cache.evictFrame(mainFrameId(page), 'document_updated');
      };
      const handleFrameNavigated = (params: unknown): void => {
        const fid =
          typeof params === 'object' && params !== null && 'frame' in params
            ? ((params as { frame?: { id?: string } }).frame?.id ?? mainFrameId(page))
            : mainFrameId(page);
        cache.evictFrame(fid, 'frame_navigated');
        const mainId = mainFrameId(page);
        if (fid !== mainId) {
          cache.evictFrame(mainId, 'frame_navigated');
        }
      };
      const handleFrameResized = (): void => {
        cache.evictFrame(mainFrameId(page), 'frame_resized');
      };

      session.on('DOM.documentUpdated', handleDocUpdated);
      session.on('Page.frameNavigated', handleFrameNavigated);
      session.on('Page.frameResized', handleFrameResized);

      // Close cleanup is registered before CDP setup awaits above so a page
      // closing during setup still disposes this target cache.
    } catch {
      // Best-effort, but do not permanently suppress retries after a transient
      // attach/listener failure. If this setup fails before listeners are
      // wired, later cache lookups should be allowed to try again; otherwise a
      // single CDP hiccup would leave SPA/page navigation invalidations disabled
      // until TTL expiry.
      ATTACHED.delete(pageKey);
    }
  })();
}
