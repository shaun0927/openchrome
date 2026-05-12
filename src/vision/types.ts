/**
 * Vision Module Types
 *
 * Shared types for the screenshot analysis and vision fallback system (#577).
 */

/** A single annotated element in the vision element map */
export interface VisionElement {
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  type: string;
  name: string;
  backendDOMNodeId?: number;
}

/** Map of element numbers to their vision data */
export type VisionElementMap = Record<number, VisionElement>;

/** Iframe traversal mode for vision analysis */
export type VisionIframeMode = 'none' | 'same-origin' | 'all';

/** Vision analysis mode: viewport-only or full-document tiled */
export type VisionAnalysisMode = 'viewport' | 'tiled';

/** Options for screenshot annotation */
export interface AnnotationOptions {
  showNumbers?: boolean;
  showBoundingBoxes?: boolean;
  showGrid?: boolean;
  gridSpacing?: number;
  format?: 'png' | 'webp';
  quality?: number;
  interactiveOnly?: boolean;
  /** When true, drop elements whose center is covered by another element via elementFromPoint. Default false (preserves byte-identity). */
  occlusionFilter?: boolean;
  /** Iframe traversal mode. Default 'none' (top frame only). */
  iframes?: VisionIframeMode;
  /** Analysis mode. Default 'viewport'. */
  mode?: VisionAnalysisMode;
}

/** Information about a traversed iframe */
export interface VisionIframeTraversed {
  frameId: string;
  origin: string;
  elementCount: number;
}

/** Information about a skipped iframe */
export interface VisionIframeSkipped {
  origin: string;
  reason: 'cross-origin' | 'depth-cap' | 'count-cap';
}

/** Iframe traversal summary */
export interface VisionIframesInfo {
  traversed: VisionIframeTraversed[];
  skipped: VisionIframeSkipped[];
}

/** A single tile screenshot from tiled mode */
export interface VisionTile {
  tileTop: number;
  imageBase64: string;
  mimeType: string;
}

/** Tiling summary */
export interface VisionTilingInfo {
  tileCount: number;
  tileHeight: number;
  tiles: VisionTile[];
  truncated: boolean;
  reason?: 'mp-cap' | 'tile-cap' | 'element-cap';
}

/** Result of screenshot analysis */
export interface AnnotatedScreenshotResult {
  screenshot: string;
  mimeType: string;
  elementMap: VisionElementMap;
  elementCount: number;
  viewport: { width: number; height: number };
  annotationTimeMs: number;
  /** Number of elements dropped by the occlusion filter. Only present when occlusionFilter is true. */
  occludedDropped?: number;
  /** Iframe traversal summary. Only present when iframes !== 'none'. */
  iframes?: VisionIframesInfo;
  /** Tiling summary. Only present when mode === 'tiled'. */
  tiling?: VisionTilingInfo;
}

/** Vision mode configuration */
export type VisionMode = 'off' | 'fallback' | 'auto';

/** Vision auto-detection hint */
export interface VisionHint {
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'canvas' | 'iframe' | 'sparse-ax' | 'repeated-failure' | 'manual';
}
