/**
 * Mutation-aware snapshot cache (#879).
 *
 * Caches the last-produced result of `read_page`, `find`, and `query_dom`
 * keyed on `(kind, frameId, docEpoch, viewportRect, paramsHash)`. The cache
 * is pure JS: it never imports Chrome/CDP types. Hosts call
 * `markFrameDirty(frameId)` from mutating tools and `evictFrame(frameId)`
 * from CDP event handlers — that decoupling mirrors the precedent set by
 * `src/core/perception/cache.ts` and keeps this module unit-testable in
 * isolation.
 *
 * Invariants (matching the issue contract):
 *   1. A cache hit MUST be byte-equal to the result that a fresh recompute
 *      would have produced at the time of the cache write.
 *   2. A mutating tool call MUST advance `docEpoch` before its response is
 *      emitted, so any later read in the same call chain sees a miss.
 *   3. The cache MUST NOT cross MCP-session boundaries: it is in-memory
 *      only and tied to the CDP target. Use one instance per target.
 *   4. Maximum entries per target: 32 (LRU eviction). Maximum entry age:
 *      30 s (TTL). Both configurable.
 *   5. Any uncertainty (frame unknown, missed event, or `kill-switch`
 *      disabled at `get`) results in a forced miss; the cache returns
 *      `null` and never serves a stale value.
 */

export type SnapshotKind =
  | 'read_page.ax'
  | 'read_page.dom'
  | 'read_page.css'
  | 'find'
  | 'query_dom';

export interface SnapshotViewportRect {
  w: number;
  h: number;
  dpr: number;
}

export interface SnapshotCacheKey {
  kind: SnapshotKind;
  frameId: string;
  /** Monotonic per-(target, frame); bumped on mutation and on CDP events. */
  docEpoch: number;
  viewportRect: SnapshotViewportRect;
  /** sha256 hex of canonical-JSON of normalised tool args. */
  paramsHash: string;
}

export interface SnapshotCacheHit<T> {
  value: T;
  cachedAt: number;
  age_ms: number;
  /**
   * Set when the host should treat the cached value as definitely fresh
   * (i.e. the entry's epoch matches the current frame epoch). Per invariant
   * 1 the cache only ever returns `certain: true` hits — uncertain lookups
   * are returned as `null`.
   */
  certain: true;
}

export interface SnapshotCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  evictionsByReason: Partial<Record<EvictReason, number>>;
}

export interface SnapshotCacheOptions {
  /** Maximum entries per target. Default 32. */
  maxEntries?: number;
  /** Maximum entry age in milliseconds. Default 30 000. */
  ttlMs?: number;
  /**
   * Time source used for TTL / age calculations. Tests override this; the
   * production default is `Date.now`.
   */
  now?: () => number;
}

interface InternalEntry {
  value: unknown;
  cachedAt: number;
  /** Epoch captured at write time. */
  docEpoch: number;
  /** Frame id captured at write time. */
  frameId: string;
}

function viewportKey(v: SnapshotViewportRect): string {
  return `${v.w}x${v.h}@${v.dpr}`;
}

function entryKey(k: SnapshotCacheKey): string {
  return `${k.kind}|${k.frameId}|${k.docEpoch}|${viewportKey(k.viewportRect)}|${k.paramsHash}`;
}

export type EvictReason =
  | 'document_updated'
  | 'frame_resized'
  | 'frame_navigated';

/**
 * Default cache configuration knobs. Mirrors the values declared in
 * `src/config/defaults.ts` (`DEFAULT_SNAPSHOT_CACHE_*`) for callers that
 * want a stand-alone instance without importing the global defaults.
 */
export const SNAPSHOT_CACHE_DEFAULT_MAX_ENTRIES = 32;
export const SNAPSHOT_CACHE_DEFAULT_TTL_MS = 30_000;

export class SnapshotCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** Per-frame monotonic doc epoch. Advances on mutation / CDP eviction. */
  private readonly docEpochs = new Map<string, number>();
  /** Insertion-ordered LRU; Map preserves insertion order in JS. */
  private readonly entries = new Map<string, InternalEntry>();

  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;
  private readonly _evictionsByReason = new Map<EvictReason, number>();

  constructor(opts: SnapshotCacheOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? SNAPSHOT_CACHE_DEFAULT_MAX_ENTRIES);
    this.ttlMs = Math.max(0, opts.ttlMs ?? SNAPSHOT_CACHE_DEFAULT_TTL_MS);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Current epoch for the named frame. Frames are lazily created on first
   * read/write/bump; an unknown frame reports epoch `0`.
   */
  getDocEpoch(frameId: string): number {
    return this.docEpochs.get(frameId) ?? 0;
  }

  /**
   * Build a key whose `docEpoch` matches the cache's view of the frame.
   * Callers can use this directly so the epoch stays consistent across
   * the `get` / recompute / `set` round-trip.
   */
  buildKey(parts: Omit<SnapshotCacheKey, 'docEpoch'>): SnapshotCacheKey {
    return { ...parts, docEpoch: this.getDocEpoch(parts.frameId) };
  }

  /**
   * Read without recomputing. Returns `null` on miss or any uncertainty.
   * Hits are LRU-touched so subsequent capacity eviction targets cold
   * entries first.
   */
  get<T>(key: SnapshotCacheKey): SnapshotCacheHit<T> | null {
    const currentEpoch = this.getDocEpoch(key.frameId);
    if (key.docEpoch !== currentEpoch) {
      this._misses += 1;
      return null;
    }
    const id = entryKey(key);
    const hit = this.entries.get(id);
    if (!hit) {
      this._misses += 1;
      return null;
    }
    // TTL check
    const now = this.now();
    const ageMs = now - hit.cachedAt;
    if (this.ttlMs > 0 && ageMs > this.ttlMs) {
      this.entries.delete(id);
      this._misses += 1;
      this._evictions += 1;
      return null;
    }
    // Touch (LRU): delete + reinsert preserves Map iteration as MRU at the end.
    this.entries.delete(id);
    this.entries.set(id, hit);
    this._hits += 1;
    return {
      value: hit.value as T,
      cachedAt: hit.cachedAt,
      age_ms: ageMs,
      certain: true,
    };
  }

  /**
   * Store a freshly-produced value. The supplied key's `docEpoch` must
   * match the cache's current epoch for the frame; if not (a race against
   * a parallel mutation), the write is dropped so we never persist a
   * stale entry.
   */
  set<T>(key: SnapshotCacheKey, value: T): void {
    const currentEpoch = this.getDocEpoch(key.frameId);
    if (key.docEpoch !== currentEpoch) {
      // Lost a race: the frame was bumped between this caller's `get` and
      // `set`. Discard the would-be entry — its key would never hit again
      // anyway, but keeping the cache empty here is cheaper than letting
      // the next `get` traverse a dead key.
      return;
    }
    const id = entryKey(key);
    // Refresh insertion order if the same id already exists.
    if (this.entries.has(id)) this.entries.delete(id);
    this.entries.set(id, {
      value,
      cachedAt: this.now(),
      docEpoch: key.docEpoch,
      frameId: key.frameId,
    });
    this.enforceCapacity();
  }

  /**
   * Called by mutating tools immediately before their successful return.
   * Bumps the frame's epoch — every previously-cached entry for this
   * frame becomes unreachable via `get` (still occupies memory until LRU
   * trims it). We also actively drop them so capacity is freed.
   */
  markFrameDirty(frameId: string): void {
    const next = (this.docEpochs.get(frameId) ?? 0) + 1;
    this.docEpochs.set(frameId, next);
    this.dropFrameEntries(frameId);
  }

  /**
   * Called by CDP event handlers on `DOM.documentUpdated`,
   * `Page.frameNavigated`, or `Page.frameResized`. Semantically identical
   * to `markFrameDirty` but kept separate so call sites stay readable.
   * The `reason` is captured in telemetry only.
   */
  evictFrame(frameId: string, reason: EvictReason): void {
    const before = this._evictions;
    this.markFrameDirty(frameId);
    const dropped = this._evictions - before;
    this._evictionsByReason.set(reason, (this._evictionsByReason.get(reason) ?? 0) + dropped);
  }

  /** Drop every entry whose stored frame id matches. */
  private dropFrameEntries(frameId: string): void {
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      if (entry.frameId === frameId) {
        this.entries.delete(id);
        dropped += 1;
      }
    }
    this._evictions += dropped;
  }

  /** Wipe all state. Used on CDP target close. */
  destroy(): void {
    this._evictions += this.entries.size;
    this.entries.clear();
    this.docEpochs.clear();
  }

  /** Alias of `destroy()` for symmetry with `PerceptualCache.clear()`. */
  clear(): void {
    this.destroy();
  }

  stats(): SnapshotCacheStats {
    return {
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      entries: this.entries.size,
      evictionsByReason: Object.fromEntries(this._evictionsByReason),
    };
  }

  /** For tests. */
  size(): number {
    return this.entries.size;
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      // Map keeps insertion order; the first key is the least-recently-used.
      const oldestId = this.entries.keys().next().value;
      if (oldestId === undefined) break;
      this.entries.delete(oldestId);
      this._evictions += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-target singleton registry
// ---------------------------------------------------------------------------

/**
 * Snapshot cache is per CDP target. The registry maps target id → cache so
 * read tools and CDP handlers can fetch the right instance without
 * threading it through every helper.
 */
const REGISTRY = new Map<string, SnapshotCache>();

export function getSnapshotCacheForTarget(targetId: string): SnapshotCache {
  let cache = REGISTRY.get(targetId);
  if (!cache) {
    cache = new SnapshotCache();
    REGISTRY.set(targetId, cache);
  }
  return cache;
}

export function disposeSnapshotCacheForTarget(targetId: string): void {
  const cache = REGISTRY.get(targetId);
  if (cache) {
    cache.destroy();
    REGISTRY.delete(targetId);
  }
}

/** Test hook: drop every per-target cache. */
export function resetSnapshotCacheRegistry(): void {
  for (const c of REGISTRY.values()) c.destroy();
  REGISTRY.clear();
}
