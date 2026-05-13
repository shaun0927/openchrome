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

export interface PerceptionValidationOptions {
  maxErrors?: number;
  maxElements?: number;
}

export interface PerceptionValidationResult {
  ok: boolean;
  errors: string[];
  truncated: boolean;
}


function sanitizePositiveInteger(value: unknown, fallback: number, cap: number): number {
  if (typeof value !== 'number') return fallback;
  if (value === Number.POSITIVE_INFINITY) return cap;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(cap, Math.max(1, Math.floor(value)));
}

export function validatePerceptionSnapshot(
  snapshot: unknown,
  options: PerceptionValidationOptions = {}
): PerceptionValidationResult {
  const maxErrors = sanitizePositiveInteger(options.maxErrors, 25, 100);
  const maxElements = options.maxElements === undefined
    ? undefined
    : sanitizePositiveInteger(options.maxElements, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER);
  const errors: string[] = [];
  const addError = (message: string): void => {
    if (errors.length < maxErrors) errors.push(message);
  };

  if (!snapshot || typeof snapshot !== 'object') {
    return { ok: false, errors: ['snapshot must be an object'], truncated: false };
  }

  const row = snapshot as Record<string, unknown>;
  if (row.version !== 1) addError('version must be 1');
  if (typeof row.provider !== 'string' || row.provider.length === 0) addError('provider is required');
  if (typeof row.tabId !== 'string' || row.tabId.length === 0) addError('tabId is required');
  if (typeof row.url !== 'string') addError('url must be a string');
  if (typeof row.capturedAt !== 'number' || !Number.isFinite(row.capturedAt)) addError('capturedAt must be a finite number');

  const viewport = row.viewport as Record<string, unknown> | undefined;
  if (!viewport || !isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) {
    addError('viewport width/height must be positive finite numbers');
  }

  if (!Array.isArray(row.elements)) {
    addError('elements must be an array');
  } else if (maxElements !== undefined && row.elements.length > maxElements) {
    addError(`elements length must be <= ${maxElements}`);
  }

  if (!Array.isArray(row.warnings) || row.warnings.some((warning) => typeof warning !== 'string')) {
    addError('warnings must be an array of strings');
  }
  if (typeof row.latencyMs !== 'number' || !Number.isFinite(row.latencyMs) || row.latencyMs < 0) {
    addError('latencyMs must be a non-negative finite number');
  }

  if (Array.isArray(row.elements)) {
    const validationLimit = maxElements === undefined ? row.elements.length : Math.min(row.elements.length, maxElements);
    for (let index = 0; index < validationLimit && errors.length < maxErrors; index += 1) {
      const element = row.elements[index];
      const prefix = `elements[${index}]`;
      if (!element || typeof element !== 'object') {
        addError(`${prefix} must be an object`);
        continue;
      }
      const el = element as Record<string, unknown>;
      if (typeof el.id !== 'string' || el.id.length === 0) addError(`${prefix}.id is required`);
      if (typeof el.type !== 'string' || !['text', 'icon', 'control', 'image', 'unknown'].includes(el.type)) addError(`${prefix}.type is invalid`);
      if (typeof el.label !== 'string') addError(`${prefix}.label must be a string`);
      if (!(typeof el.interactive === 'boolean' || el.interactive === 'unknown')) addError(`${prefix}.interactive is invalid`);
      if (typeof el.source !== 'string' || el.source.length === 0) addError(`${prefix}.source is required`);
      validateBox(el.bbox, `${prefix}.bbox`, addError, false);
      validateBox(el.bboxRatio, `${prefix}.bboxRatio`, addError, true);
      if (el.confidence !== undefined && (typeof el.confidence !== 'number' || !Number.isFinite(el.confidence) || el.confidence < 0 || el.confidence > 1)) {
        addError(`${prefix}.confidence must be 0..1`);
      }
    }
  }

  return { ok: errors.length === 0, errors, truncated: errors.length >= maxErrors };
}

function validateBox(value: unknown, prefix: string, addError: (message: string) => void, ratio: boolean): void {
  if (!value || typeof value !== 'object') {
    addError(`${prefix} is required`);
    return;
  }
  const box = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = box[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      addError(`${prefix}.${key} must be a non-negative finite number`);
    } else if (ratio && n > 1) {
      addError(`${prefix}.${key} must be <= 1`);
    }
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
