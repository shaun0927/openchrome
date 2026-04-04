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

/** Options for screenshot annotation */
export interface AnnotationOptions {
  showNumbers?: boolean;
  showBoundingBoxes?: boolean;
  showGrid?: boolean;
  gridSpacing?: number;
  format?: 'png' | 'webp';
  quality?: number;
  interactiveOnly?: boolean;
}

/** Result of screenshot analysis */
export interface AnnotatedScreenshotResult {
  screenshot: string;
  mimeType: string;
  elementMap: VisionElementMap;
  elementCount: number;
  viewport: { width: number; height: number };
  annotationTimeMs: number;
}

/** Vision mode configuration */
export type VisionMode = 'off' | 'fallback' | 'auto';

/** Vision auto-detection hint */
export interface VisionHint {
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'canvas' | 'iframe' | 'sparse-ax' | 'repeated-failure' | 'manual';
}
