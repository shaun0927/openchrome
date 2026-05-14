import { redactValue } from '../trace/redactor';
import type {
  ElementPickRecorderInput,
  ElementPickerAncestryNode,
  ElementPickerBoundingBox,
  ElementPickerViewport,
  PickedElement,
  PickedElementSelectors,
} from './types';

const MAX_TEXT_CHARS = 200;
const MAX_DOM_SNIPPET_BYTES = 4096;
const MAX_SCREENSHOT_BYTES = 200 * 1024;

const CSS_ATTRS = ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label'] as const;
const STYLE_ALLOWLIST = new Set([
  'display',
  'position',
  'visibility',
  'opacity',
  'pointer-events',
  'cursor',
  'role',
]);

export interface ScreenshotValidationResult {
  ok: boolean;
  error?: 'snapshot_too_large';
  bytes: number;
}

export function buildPickedElement(input: ElementPickRecorderInput): PickedElement {
  return {
    nodeRef: input.nodeRef ?? null,
    backendNodeId: input.backendNodeId ?? null,
    loaderId: input.loaderId ?? null,
    selectors: synthesizeSelectors(input),
    boundingBox: clampBoundingBox(input.boundingBox, input.viewport),
    ...(input.screenshotPng && validateScreenshotPng(input.screenshotPng).ok ? { screenshotPng: input.screenshotPng } : {}),
    computedStyle: filterComputedStyle(input.computedStyle ?? {}),
    domSnippet: redactDomSnippet(input.domSnippet),
    pickedAt: input.pickedAt ?? Date.now(),
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
  };
}

export function synthesizeSelectors(input: Pick<ElementPickRecorderInput, 'ancestry' | 'role' | 'accessibleName' | 'text'>): PickedElementSelectors {
  const cssPath = synthesizeCssPath(input.ancestry);
  const xPath = synthesizeXPath(input.ancestry);
  const nthOfType = synthesizeNthOfTypePath(input.ancestry);
  return {
    ...(input.role ? { role: input.role } : {}),
    ...(input.accessibleName ? { accessibleName: capText(input.accessibleName) } : {}),
    ...(input.text ? { text: capText(input.text.trim()) } : {}),
    cssPath,
    xPath,
    nthOfType,
  };
}

export function synthesizeCssPath(ancestry: ElementPickerAncestryNode[]): string {
  const parts = normalizedAncestry(ancestry).map((node) => {
    const tag = normalizeTag(node.tagName);
    if (node.id) return `${tag}#${cssEscape(node.id)}`;
    for (const attr of CSS_ATTRS) {
      const value = node.attributes?.[attr];
      if (value) return `${tag}[${attr}="${escapeAttr(value)}"]`;
    }
    const classes = (node.classes ?? []).filter(Boolean).slice(0, 2).map((klass) => `.${cssEscape(klass)}`).join('');
    if (classes) return `${tag}${classes}:nth-of-type(${safeNth(node.nthOfType)})`;
    return `${tag}:nth-of-type(${safeNth(node.nthOfType)})`;
  });
  return parts.join(' > ');
}

export function synthesizeXPath(ancestry: ElementPickerAncestryNode[]): string {
  return '/' + normalizedAncestry(ancestry)
    .map((node) => `${normalizeTag(node.tagName)}[${safeNth(node.nthOfType)}]`)
    .join('/');
}

export function synthesizeNthOfTypePath(ancestry: ElementPickerAncestryNode[]): string {
  return normalizedAncestry(ancestry)
    .map((node) => `${normalizeTag(node.tagName)}:nth-of-type(${safeNth(node.nthOfType)})`)
    .join(' > ');
}

export function clampBoundingBox(box: ElementPickerBoundingBox, viewport: ElementPickerViewport, padding = 8): ElementPickerBoundingBox {
  const viewportWidth = Math.max(0, finite(viewport.width));
  const viewportHeight = Math.max(0, finite(viewport.height));
  const x1 = Math.max(0, finite(box.x) - padding);
  const y1 = Math.max(0, finite(box.y) - padding);
  const x2 = Math.min(viewportWidth, finite(box.x) + Math.max(0, finite(box.width)) + padding);
  const y2 = Math.min(viewportHeight, finite(box.y) + Math.max(0, finite(box.height)) + padding);
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.max(0, Math.round(x2 - x1)),
    height: Math.max(0, Math.round(y2 - y1)),
  };
}

export function validateScreenshotPng(base64Png: string, maxBytes = MAX_SCREENSHOT_BYTES): ScreenshotValidationResult {
  const bytes = Buffer.byteLength(base64Png, 'base64');
  if (bytes > maxBytes) return { ok: false, error: 'snapshot_too_large', bytes };
  return { ok: true, bytes };
}

export function redactDomSnippet(snippet: string): string {
  const capped = Buffer.from(snippet, 'utf8').subarray(0, MAX_DOM_SNIPPET_BYTES).toString('utf8');
  const htmlRedacted = capped.replace(
    /(<[^>]*(?:name|type)=["'][^"']*(?:password|passwd|pwd|secret|token|api[_-]?key)[^"']*["'][^>]*\svalue=)(["'])(.*?)(\2)/gi,
    (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`,
  );
  return String(redactValue(htmlRedacted));
}

export function filterComputedStyle(style: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    if (STYLE_ALLOWLIST.has(key)) out[key] = value;
  }
  return out;
}

function normalizedAncestry(ancestry: ElementPickerAncestryNode[]): ElementPickerAncestryNode[] {
  if (!Array.isArray(ancestry) || ancestry.length === 0) {
    throw new Error('element picker ancestry must include at least one node');
  }
  return ancestry;
}

function normalizeTag(tagName: string): string {
  const tag = String(tagName || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return 'element';
  return tag;
}

function safeNth(nth: number): number {
  return Number.isInteger(nth) && nth > 0 ? nth : 1;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function capText(value: string): string {
  return value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
}

function cssEscape(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function escapeAttr(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
