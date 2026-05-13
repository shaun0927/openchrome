import type { AnnotatedScreenshotResult, PerceptionElement, PerceptionSnapshot, VisionElement } from './types';

export interface PerceptionProviderOptions {
  maxElements?: number;
  maxLabelLength?: number;
}

export interface PerceptionProvider {
  readonly name: string;
  capture(tabId: string, url: string, options?: PerceptionProviderOptions): Promise<PerceptionSnapshot>;
}

const DEFAULT_MAX_ELEMENTS = 500;
const DEFAULT_MAX_LABEL_LENGTH = 160;
const SECRET_PATTERNS = [
  /super-secret-fixture-password/gi,
  /password\s*[:=]\s*\S+/gi,
  /mfa\s*[:=]\s*\S+/gi,
  /otp\s*[:=]\s*\S+/gi,
];

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function sanitizePerceptionLabel(label: string | undefined, maxLength = DEFAULT_MAX_LABEL_LENGTH): string {
  let out = (label || '').replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  if (out.length > maxLength) {
    out = out.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
  }
  return out;
}

export function roleToPerceptionType(role: string | undefined): PerceptionElement['type'] {
  const r = (role || '').toLowerCase();
  if (['button', 'link', 'checkbox', 'radio', 'switch', 'slider', 'combobox', 'searchbox', 'textbox', 'menuitem', 'tab', 'option'].includes(r)) {
    return 'control';
  }
  if (['img', 'image', 'svg', 'video', 'canvas'].includes(r)) return 'image';
  if (['heading', 'paragraph', 'statictext', 'text'].includes(r)) return 'text';
  return 'unknown';
}

export function isInteractiveRole(role: string | undefined): boolean | 'unknown' {
  const r = (role || '').toLowerCase();
  if (['button', 'link', 'checkbox', 'radio', 'switch', 'slider', 'combobox', 'searchbox', 'textbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'listbox', 'option', 'treeitem', 'gridcell', 'columnheader', 'rowheader', 'scrollbar', 'spinbutton'].includes(r)) {
    return true;
  }
  if (['heading', 'paragraph', 'statictext', 'text', 'img', 'image'].includes(r)) return false;
  return 'unknown';
}

export function visionElementToPerceptionElement(
  element: VisionElement,
  viewport: { width: number; height: number },
  source = 'dom-annotator',
  maxLabelLength = DEFAULT_MAX_LABEL_LENGTH
): PerceptionElement {
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const x = clamp(element.x, 0, viewportWidth);
  const y = clamp(element.y, 0, viewportHeight);
  const width = clamp(element.width, 0, viewportWidth - x);
  const height = clamp(element.height, 0, viewportHeight - y);
  const role = element.type || 'unknown';

  return {
    id: `v${element.number}`,
    type: roleToPerceptionType(role),
    label: sanitizePerceptionLabel(element.name || role, maxLabelLength),
    role,
    interactive: isInteractiveRole(role),
    bbox: { x, y, width, height },
    bboxRatio: {
      x: clamp(x / viewportWidth, 0, 1),
      y: clamp(y / viewportHeight, 0, 1),
      width: clamp(width / viewportWidth, 0, 1),
      height: clamp(height / viewportHeight, 0, 1),
    },
    source,
    backendDOMNodeId: element.backendDOMNodeId,
  };
}

export function buildPerceptionSnapshotFromAnnotatedResult(
  result: AnnotatedScreenshotResult,
  args: {
    provider?: string;
    tabId: string;
    url: string;
    capturedAt?: number;
    warnings?: string[];
    maxElements?: number;
    maxLabelLength?: number;
  }
): PerceptionSnapshot {
  const provider = args.provider || 'dom-annotator';
  const maxElements = Math.max(0, args.maxElements ?? DEFAULT_MAX_ELEMENTS);
  const entries = Object.values(result.elementMap).slice(0, maxElements);
  const warnings = [...(args.warnings || [])];
  const total = Object.keys(result.elementMap).length;
  if (total > entries.length) {
    warnings.push(`Perception snapshot truncated from ${total} to ${entries.length} elements.`);
  }

  return {
    version: 1,
    provider,
    tabId: args.tabId,
    url: args.url,
    capturedAt: args.capturedAt ?? Date.now(),
    viewport: result.viewport,
    screenshotMimeType: result.mimeType,
    elements: entries.map((el) => visionElementToPerceptionElement(el, result.viewport, provider, args.maxLabelLength)),
    warnings,
    latencyMs: result.annotationTimeMs,
  };
}

export function formatPerceptionSnapshotAsText(snapshot: PerceptionSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
