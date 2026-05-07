/**
 * Per-frame perceptual-metadata cache (#709 v2).
 *
 * Keyed on `(frameId, docCounter, viewportRect)` — invalidated on
 * `DOM.documentUpdated` and `Page.frameResized`. Hosts call
 * `bumpDoc(frameId)` from the CDP event handlers; the cache itself
 * does not subscribe — that decoupling keeps the module pure-JS and
 * easy to unit-test.
 *
 * The cache is keyed by a string built from the components above, so
 * the implementation is just a Map under the hood. We give it a
 * dedicated module so future strategies (LRU bounded by memory, etc.)
 * are a non-breaking swap.
 */

import type { PerceptualMetadata, ViewportRect } from './types';

interface CacheKey {
  frameId: string;
  docCounter: number;
  viewport: ViewportRect;
  backendNodeId: number;
}

function keyString(k: CacheKey): string {
  return `${k.frameId}|${k.docCounter}|${k.viewport.x},${k.viewport.y},${k.viewport.w},${k.viewport.h}|${k.backendNodeId}`;
}

export class PerceptualCache {
  private readonly entries = new Map<string, PerceptualMetadata>();
  /** Per-frame monotonic doc counter. Bumped on DOM.documentUpdated. */
  private readonly docCounters = new Map<string, number>();

  /**
   * Read or compute. The host supplies the `compute` function which is
   * only invoked on a miss. The closure captures any node-probe state
   * — the cache only deals with the cached value.
   */
  getOrCompute(
    keyParts: { frameId: string; viewport: ViewportRect; backendNodeId: number },
    compute: () => PerceptualMetadata,
  ): PerceptualMetadata {
    const docCounter = this.getDocCounter(keyParts.frameId);
    const k = keyString({ ...keyParts, docCounter });
    const hit = this.entries.get(k);
    if (hit) return hit;
    const fresh = compute();
    this.entries.set(k, fresh);
    return fresh;
  }

  /** Read without computing. Returns undefined on miss. */
  get(
    keyParts: { frameId: string; viewport: ViewportRect; backendNodeId: number },
  ): PerceptualMetadata | undefined {
    const docCounter = this.getDocCounter(keyParts.frameId);
    return this.entries.get(keyString({ ...keyParts, docCounter }));
  }

  /**
   * Invalidate every entry for `frameId`. Hosts call this from
   * `DOM.documentUpdated` (or any equivalent invalidation signal).
   */
  bumpDoc(frameId: string): void {
    const next = (this.docCounters.get(frameId) ?? 0) + 1;
    this.docCounters.set(frameId, next);
    // Drop entries for the previous counter — keep memory bounded.
    const prefix = `${frameId}|${next - 1}|`;
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  /** Drop everything (test hook + reset on serve restart). */
  clear(): void {
    this.entries.clear();
    this.docCounters.clear();
  }

  /** Inspect the current docCounter for a frame (debug + tests). */
  getDocCounter(frameId: string): number {
    return this.docCounters.get(frameId) ?? 0;
  }

  /** For tests. */
  size(): number {
    return this.entries.size;
  }
}
