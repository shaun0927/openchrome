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

/** Provider-neutral perception element for visual grounding. */
export interface PerceptionElement {
  id: string;
  type: 'text' | 'icon' | 'control' | 'image' | 'unknown';
  label: string;
  role?: string;
  interactive: boolean | 'unknown';
  bbox: { x: number; y: number; width: number; height: number };
  bboxRatio: { x: number; y: number; width: number; height: number };
  confidence?: number;
  source: 'dom-annotator' | 'omniparser-http' | 'mock' | string;
  backendDOMNodeId?: number;
  refId?: string;
  metadata?: Record<string, string | number | boolean>;
}

/** Provider-neutral snapshot returned by visual perception providers. */
export interface PerceptionSnapshot {
  version: 1;
  provider: string;
  tabId: string;
  url: string;
  capturedAt: number;
  viewport: { width: number; height: number };
  screenshotHash?: string;
  screenshotMimeType?: string;
  elements: PerceptionElement[];
  warnings: string[];
  latencyMs: number;
}

/** Vision mode configuration */
export type VisionMode = 'off' | 'fallback' | 'auto';

/** Vision auto-detection hint */
export interface VisionHint {
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  source: 'canvas' | 'iframe' | 'sparse-ax' | 'repeated-failure' | 'manual';
}
