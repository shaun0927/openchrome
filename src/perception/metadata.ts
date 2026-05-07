/**
 * Perceptual metadata classifier (#709).
 *
 * Pure function — no CDP, no DOM, no I/O. Hosts (the dom-serializer
 * pipeline + the cross-check module #710) build a `NodeProbe` from
 * live state and call `computePerceptualMetadata` to get the
 * structured classification an LLM can reason about.
 */

import type {
  EffectiveDisplay,
  InteractionFeasibility,
  NodeProbe,
  PerceptualMetadata,
  PixelBox,
  ViewportRect,
} from './types';

/** Multiply the opacity chain. Empty chain → 1.0. */
export function effectiveOpacity(chain: ReadonlyArray<number>): number {
  if (chain.length === 0) return 1;
  let v = 1;
  for (const o of chain) v *= clamp01(o);
  return v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Strict pixel-rectangle intersection (positive overlap on both axes). */
export function intersects(a: PixelBox, b: ViewportRect): boolean {
  if (a.w <= 0 || a.h <= 0) return false;
  if (b.w <= 0 || b.h <= 0) return false;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

function isZeroSize(box: PixelBox | null): boolean {
  if (!box) return true;
  return box.w <= 0 || box.h <= 0;
}

function classifyEffectiveDisplay(probe: NodeProbe): EffectiveDisplay {
  if (probe.ancestorDisplayNone || probe.display === 'none') return 'hidden_display_none';
  if (probe.ancestorVisibilityHidden || probe.visibility === 'hidden' || probe.visibility === 'collapse') {
    return 'hidden_visibility';
  }
  // display: contents — node has no box; bucket depends on whether any
  // descendant has one (per #709 v2 P1 fix for the missing enum value).
  if (probe.display === 'contents') {
    return probe.hasChildBoxes ? 'rendered' : 'display_contents_no_box';
  }
  return 'rendered';
}

function classifyInteractionFeasibility(
  effective: EffectiveDisplay,
  box: PixelBox | null,
  viewport: ViewportRect,
  topElementMatches: boolean,
): InteractionFeasibility {
  if (effective !== 'rendered' && effective !== 'covered_by' && effective !== 'off_screen') {
    return 'outside_viewport'; // hidden/collapsed/contents-no-box → all flat-out unreachable
  }
  if (isZeroSize(box)) return 'zero_size';
  if (!box) return 'zero_size';
  if (effective === 'off_screen' || !intersects(box, viewport)) return 'outside_viewport';
  if (!topElementMatches) return 'blocked_by_overlay';
  return 'ok';
}

/**
 * Top-level: probe + viewport → PerceptualMetadata.
 *
 * Hosts may set `topElementBackendNodeId` to null when they did not
 * call `elementFromPoint` (e.g., bulk read_page mode); the rollup then
 * conservatively assumes the node is on top — this is the same default
 * the legacy compression layer used.
 */
export function computePerceptualMetadata(
  probe: NodeProbe,
  viewport: ViewportRect,
): PerceptualMetadata {
  const baseDisplay = classifyEffectiveDisplay(probe);
  const opacity = effectiveOpacity(probe.opacityChain);
  const box = probe.pixelBox;

  // off_screen takes priority over covered_by — there's nothing to
  // cover an element that isn't on screen in the first place.
  let effective: EffectiveDisplay = baseDisplay;
  if (effective === 'rendered' && box && !intersects(box, viewport)) {
    effective = 'off_screen';
  }

  // covered_by is computed AFTER off-screen so we never falsely report
  // "covered" for a node that's simply outside the viewport.
  let coveredByNodeId: number | undefined;
  if (effective === 'rendered' && probe.topElementBackendNodeId !== null) {
    if (probe.topElementBackendNodeId !== probe.backendNodeId) {
      effective = 'covered_by';
      coveredByNodeId = probe.topElementBackendNodeId;
    }
  }

  const topElementMatches =
    probe.topElementBackendNodeId === null ||
    probe.topElementBackendNodeId === probe.backendNodeId;

  const feasibility = classifyInteractionFeasibility(effective, box, viewport, topElementMatches);

  const md: PerceptualMetadata = {
    pixelBox: box,
    viewportVisible: !!box && intersects(box, viewport),
    effectiveOpacity: opacity,
    effectiveDisplay: effective,
    interactionFeasibility: feasibility,
  };
  if (coveredByNodeId !== undefined) md.coveredByNodeId = coveredByNodeId;
  return md;
}
