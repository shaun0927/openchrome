/**
 * Per-frame perceptual-metadata cache (#709 v2).
 *
 * Keyed on `(frameId, docCounter, viewportRect, backendNodeId, styleHash)` —
 * invalidated on `DOM.documentUpdated`, `Page.frameResized`, and computed-style
 * changes. `docCounter` handles full document replacement; `styleHash` handles
 * in-document SPA mutations (class/attribute/style changes that flip display,
 * visibility, pointer-events, or geometry) without a documentUpdated event.
 * Hosts call `bumpDoc(frameId)` from the CDP event handlers; the cache itself
 * does not subscribe — that decoupling keeps the module pure-JS and easy to
 * unit-test.
 *
 * The cache is keyed by a string built from the components above, so
 * the implementation is just a Map under the hood. We give it a
 * dedicated module so future strategies (LRU bounded by memory, etc.)
 * are a non-breaking swap.
 *
 * `styleHash` now covers ALL fields that `computePerceptualMetadata` reads,
 * including `topElementBackendNodeId`, `descendantBackendNodeIds`, and
 * `hasChildBoxes` — not just CSS style fields. This prevents stale entries
 * when an overlay appears/disappears or a display:contents child-box state
 * changes without triggering a documentUpdated event.
 */

import type { NodeProbe, PerceptualMetadata, ViewportRect } from './types';

interface CacheKey {
  frameId: string;
  docCounter: number;
  viewport: ViewportRect;
  backendNodeId: number;
  styleHash: string;
}

function keyString(k: CacheKey): string {
  return `${k.frameId}|${k.docCounter}|${k.viewport.x},${k.viewport.y},${k.viewport.w},${k.viewport.h}|${k.backendNodeId}|${k.styleHash}`;
}

/**
 * Compute a stable hash of ALL fields that `computePerceptualMetadata` reads
 * from a NodeProbe. Include this in the `styleHash` key part so that
 * in-document SPA mutations (which do not fire DOM.documentUpdated) still
 * produce a cache miss.
 *
 * Covered fields:
 *   - CSS/style: display, visibility, pointerEvents, opacityChain,
 *     ancestorDisplayNone, ancestorVisibilityHidden, pixelBox
 *   - Overlay/hit-test: topElementBackendNodeId
 *   - Descendant set: descendantBackendNodeIds (serialised as a sorted array
 *     for stability — set iteration order is insertion-order and may vary)
 *   - display:contents child-box predicate: hasChildBoxes
 */
export function computeStyleHash(probe: Pick<NodeProbe,
  'display' | 'visibility' | 'pointerEvents' | 'pixelBox' |
  'opacityChain' | 'ancestorDisplayNone' | 'ancestorVisibilityHidden' |
  'topElementBackendNodeId' | 'descendantBackendNodeIds' | 'hasChildBoxes'
>): string {
  const box = probe.pixelBox;
  const boxStr = box ? `${box.x},${box.y},${box.w},${box.h}` : 'null';
  const topId = probe.topElementBackendNodeId === null ? 'null' : String(probe.topElementBackendNodeId);
  const descIds = probe.descendantBackendNodeIds !== undefined
    ? [...probe.descendantBackendNodeIds].sort((a, b) => a - b).join(',')
    : '';
  return [
    probe.display,
    probe.visibility,
    probe.pointerEvents ?? 'auto',
    probe.ancestorDisplayNone ? '1' : '0',
    probe.ancestorVisibilityHidden ? '1' : '0',
    probe.opacityChain.join(','),
    boxStr,
    topId,
    descIds,
    probe.hasChildBoxes ? '1' : '0',
  ].join('|');
}

export class PerceptualCache {
  private readonly entries = new Map<string, PerceptualMetadata>();
  /** Per-frame monotonic doc counter. Bumped on DOM.documentUpdated. */
  private readonly docCounters = new Map<string, number>();
  /**
   * Last-seen viewport per `frameId|docCounter`. When the viewport
   * changes for a given doc, all entries with the previous viewport
   * are evicted so memory stays bounded across window resizes and
   * device-emulation toggles — matching the header-comment contract.
   */
  private readonly lastViewport = new Map<string, string>();

  /**
   * Read or compute. The host supplies the `compute` function which is
   * only invoked on a miss. The `styleHash` must be derived from the
   * current NodeProbe via `computeStyleHash` before calling — a changed
   * hash produces a new key string and thus a cache miss, defeating
   * in-document SPA staleness.
   */
  getOrCompute(
    keyParts: { frameId: string; viewport: ViewportRect; backendNodeId: number; styleHash: string },
    compute: () => PerceptualMetadata,
  ): PerceptualMetadata {
    const docCounter = this.getDocCounter(keyParts.frameId);
    this.evictStaleViewport(keyParts.frameId, docCounter, keyParts.viewport);
    const k = keyString({ ...keyParts, docCounter });
    const hit = this.entries.get(k);
    if (hit) return hit;
    const fresh = compute();
    this.entries.set(k, fresh);
    return fresh;
  }

  /** Read without computing. Returns undefined on miss. */
  get(
    keyParts: { frameId: string; viewport: ViewportRect; backendNodeId: number; styleHash: string },
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
    // Drop the stale-viewport tracking key for the old counter.
    this.lastViewport.delete(`${frameId}|${next - 1}`);
  }

  /** Drop everything (test hook + reset on serve restart). */
  clear(): void {
    this.entries.clear();
    this.docCounters.clear();
    this.lastViewport.clear();
  }

  /**
   * If the incoming viewport for `(frameId, docCounter)` differs from
   * the last-seen one, evict all entries that share the old viewport
   * prefix for this doc, then record the new viewport as current.
   */
  private evictStaleViewport(frameId: string, docCounter: number, viewport: ViewportRect): void {
    const vpStr = `${viewport.x},${viewport.y},${viewport.w},${viewport.h}`;
    const trackKey = `${frameId}|${docCounter}`;
    const prev = this.lastViewport.get(trackKey);
    if (prev === undefined) {
      this.lastViewport.set(trackKey, vpStr);
      return;
    }
    if (prev === vpStr) return;
    // Viewport changed — drop all cached entries for the old viewport.
    const stalePrefix = `${frameId}|${docCounter}|${prev}|`;
    for (const k of this.entries.keys()) {
      if (k.startsWith(stalePrefix)) this.entries.delete(k);
    }
    this.lastViewport.set(trackKey, vpStr);
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
