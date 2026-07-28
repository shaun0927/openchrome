import { validatePerceptionSnapshot } from './perception-provider';
import type { PerceptionElement, PerceptionSnapshot } from './types';

export const DOM_PERCEPTION_MAX_AGE_MS = 60_000;
export const VISUAL_PERCEPTION_MAX_AGE_MS = 15_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;
const MAX_PERCEPTION_ELEMENTS = 500;
const MIN_VISUAL_TARGET_SIZE_PX = 4;

const UNSAFE_VISUAL_LABEL = /\b(delete|deletion|remove|destroy|confirm|pay|payments?|purchases?|checkout|transfers?|passwords?|mfa|otp|credentials?|secrets?)\b/i;

export type PerceptionTargetFailureReason =
  | 'malformed_snapshot'
  | 'tab_mismatch'
  | 'url_mismatch'
  | 'element_not_found'
  | 'duplicate_element_id'
  | 'element_not_interactive'
  | 'invalid_backend_node_id'
  | 'invalid_bbox'
  | 'snapshot_from_future'
  | 'snapshot_stale'
  | 'viewport_mismatch'
  | 'unsafe_visual_label';

export interface ResolvedPerceptionTarget {
  snapshot: PerceptionSnapshot;
  element: PerceptionElement;
  resolution: 'backend-node' | 'snapshot-bbox';
  snapshotAgeMs: number;
  point: { x: number; y: number };
}

export type ResolvePerceptionTargetResult =
  | { ok: true; target: ResolvedPerceptionTarget }
  | {
      ok: false;
      code: 'INVALID_PERCEPTION_TARGET' | 'STALE_PERCEPTION_TARGET';
      reason: PerceptionTargetFailureReason;
      message: string;
      details?: Record<string, unknown>;
    };

export interface ResolvePerceptionTargetInput {
  snapshot: unknown;
  elementId: unknown;
  tabId: string;
  url: string;
  viewport: { width: number; height: number };
  now?: number;
}

export function isUnsafeVisualTargetLabel(value: string): boolean {
  return UNSAFE_VISUAL_LABEL.test(value);
}

export function resolvePerceptionTarget(input: ResolvePerceptionTargetInput): ResolvePerceptionTargetResult {
  const validation = validatePerceptionSnapshot(input.snapshot, {
    maxErrors: 10,
    maxElements: MAX_PERCEPTION_ELEMENTS,
  });
  if (!validation.ok) {
    return failure('INVALID_PERCEPTION_TARGET', 'malformed_snapshot', 'Perception snapshot validation failed.', {
      errors: validation.errors,
      truncated: validation.truncated,
    });
  }

  const snapshot = input.snapshot as PerceptionSnapshot;
  if (typeof input.elementId !== 'string' || input.elementId.length === 0) {
    return failure('INVALID_PERCEPTION_TARGET', 'element_not_found', 'perception.elementId must be a non-empty string.');
  }
  if (snapshot.tabId !== input.tabId) {
    return failure('INVALID_PERCEPTION_TARGET', 'tab_mismatch', 'Perception snapshot belongs to a different tab.', {
      snapshotTabId: snapshot.tabId,
      liveTabId: input.tabId,
    });
  }
  if (snapshot.url !== input.url) {
    return failure('STALE_PERCEPTION_TARGET', 'url_mismatch', 'Perception snapshot URL does not match the live page.', {
      snapshotUrl: snapshot.url,
      liveUrl: input.url,
    });
  }

  const matches = snapshot.elements.filter((element) => element.id === input.elementId);
  if (matches.length === 0) {
    return failure('INVALID_PERCEPTION_TARGET', 'element_not_found', `Perception element "${input.elementId}" was not found.`);
  }
  if (matches.length > 1) {
    return failure('INVALID_PERCEPTION_TARGET', 'duplicate_element_id', `Perception element id "${input.elementId}" is not unique.`);
  }

  const element = matches[0];
  if (element.interactive !== true) {
    return failure('INVALID_PERCEPTION_TARGET', 'element_not_interactive', 'Selected perception element is not explicitly interactive.');
  }

  const backendNodeId = element.backendDOMNodeId;
  if (backendNodeId !== undefined && (!Number.isInteger(backendNodeId) || backendNodeId <= 0)) {
    return failure('INVALID_PERCEPTION_TARGET', 'invalid_backend_node_id', 'backendDOMNodeId must be a positive integer when present.');
  }

  if (!isCredibleBox(element, snapshot.viewport, backendNodeId === undefined)) {
    return failure('INVALID_PERCEPTION_TARGET', 'invalid_bbox', 'Selected perception element has an invalid or out-of-bounds box.');
  }

  const now = input.now ?? Date.now();
  const snapshotAgeMs = now - snapshot.capturedAt;
  if (snapshotAgeMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    return failure('INVALID_PERCEPTION_TARGET', 'snapshot_from_future', 'Perception snapshot capture time is too far in the future.', {
      snapshotAgeMs,
    });
  }

  const visualOnly = backendNodeId === undefined;
  const maxAgeMs = visualOnly ? VISUAL_PERCEPTION_MAX_AGE_MS : DOM_PERCEPTION_MAX_AGE_MS;
  if (snapshotAgeMs > maxAgeMs) {
    return failure('STALE_PERCEPTION_TARGET', 'snapshot_stale', `Perception snapshot is older than ${maxAgeMs}ms.`, {
      snapshotAgeMs,
      maxAgeMs,
    });
  }

  if (visualOnly && !sameViewport(snapshot.viewport, input.viewport)) {
    return failure('STALE_PERCEPTION_TARGET', 'viewport_mismatch', 'Visual-only perception target requires an unchanged viewport.', {
      snapshotViewport: snapshot.viewport,
      liveViewport: input.viewport,
    });
  }

  if (visualOnly && isUnsafeVisualTargetLabel(`${element.label} ${element.role || ''}`)) {
    return failure('INVALID_PERCEPTION_TARGET', 'unsafe_visual_label', 'Unsafe visual-only target requires DOM-backed identity or user intervention.');
  }

  return {
    ok: true,
    target: {
      snapshot,
      element,
      resolution: visualOnly ? 'snapshot-bbox' : 'backend-node',
      snapshotAgeMs: Math.max(0, snapshotAgeMs),
      point: {
        x: Math.round(element.bbox.x + element.bbox.width / 2),
        y: Math.round(element.bbox.y + element.bbox.height / 2),
      },
    },
  };
}

function failure(
  code: 'INVALID_PERCEPTION_TARGET' | 'STALE_PERCEPTION_TARGET',
  reason: PerceptionTargetFailureReason,
  message: string,
  details?: Record<string, unknown>,
): ResolvePerceptionTargetResult {
  return { ok: false, code, reason, message, ...(details ? { details } : {}) };
}

function sameViewport(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return a.width === b.width && a.height === b.height;
}

function isCredibleBox(
  element: PerceptionElement,
  viewport: { width: number; height: number },
  visualOnly: boolean,
): boolean {
  const { x, y, width, height } = element.bbox;
  const minSize = visualOnly ? MIN_VISUAL_TARGET_SIZE_PX : 1;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (x < 0 || y < 0 || width < minSize || height < minSize) return false;
  if (x + width > viewport.width || y + height > viewport.height) return false;

  const ratio = element.bboxRatio;
  if (ratio.x + ratio.width > 1 || ratio.y + ratio.height > 1) return false;
  return true;
}
