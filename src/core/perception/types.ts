/**
 * Shared types for the Adversarial-Robust Perception subsystem (#700).
 *
 * The compression layer (`src/dom/dom-serializer.ts`) and the cross-
 * check module (#710) both consume these — keeping the shapes in one
 * file avoids drift.
 */

export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `effectiveDisplay` enum per #709 v2:
 *   rendered                 — element has a box and is laid out
 *   hidden_display_none      — display:none anywhere on ancestor chain
 *   hidden_visibility        — visibility:hidden / collapse
 *   off_screen               — pixelBox does not intersect the viewport
 *   covered_by               — elementFromPoint at center is a different node
 *   display_contents_no_box  — display:contents (parent has no box itself)
 */
export type EffectiveDisplay =
  | 'rendered'
  | 'hidden_display_none'
  | 'hidden_visibility'
  | 'off_screen'
  | 'covered_by'
  | 'display_contents_no_box';

export type InteractionFeasibility =
  | 'ok'
  | 'blocked_by_overlay'
  | 'outside_viewport'
  | 'zero_size';

export interface PerceptualMetadata {
  /** Element bounding box in viewport coordinates. Null when no layout. */
  pixelBox: PixelBox | null;
  /** True iff pixelBox intersects the viewport. */
  viewportVisible: boolean;
  /** Cumulative opacity from root to this node (0..1). */
  effectiveOpacity: number;
  effectiveDisplay: EffectiveDisplay;
  /** When effectiveDisplay === 'covered_by', the covering node. */
  coveredByNodeId?: number;
  /** Derived rollup callers can switch on without re-implementing rules. */
  interactionFeasibility: InteractionFeasibility;
}

/** Per-node input the metadata function consumes. */
export interface NodeProbe {
  /** Stable CDP backendNodeId. NEVER use the unstable `nodeId`. */
  backendNodeId: number;
  /** Computed `display`: `block`, `none`, `contents`, `flex`, ... */
  display: string;
  /** Computed `visibility`: `visible`, `hidden`, `collapse`. */
  visibility: string;
  /**
   * Cumulative opacity values from the document root down to this node
   * (each multiplied yields effectiveOpacity). Empty array → 1.0.
   */
  opacityChain: number[];
  /** Box model from `DOM.getBoxModel`; null when the node has no layout. */
  pixelBox: PixelBox | null;
  /**
   * `document.elementFromPoint(cx, cy)` resolved to backendNodeId, or
   * null when nothing was found / the call wasn't made.
   */
  topElementBackendNodeId: number | null;
  /**
   * True iff at least one descendant has a layout box. Only used for
   * `display: contents` classification — set to false for ordinary
   * leaves (it's just the predicate "do my children have boxes").
   */
  hasChildBoxes: boolean;
  /**
   * True iff any ancestor has display:none / visibility:hidden. Saves
   * the metadata function from re-walking the chain.
   */
  ancestorDisplayNone: boolean;
  ancestorVisibilityHidden: boolean;
}
