import type { Page } from 'puppeteer-core';
import { DEFAULT_SCREENSHOT_QUALITY, DEFAULT_SCREENSHOT_TIMEOUT_MS } from '../../config/defaults';
import { getRemainingBudget, type ToolContext } from '../../types/mcp';
import { bufferToBase64WithPayloadGuard, resolveViewportDimensions, validateCaptureArea } from '../../utils/screenshot-guards';
import type { PerceptionElement, PerceptionSnapshot } from '../types';
import { sanitizePerceptionLabel, type PerceptionProviderOptions } from '../perception-provider';

export interface OmniParserHttpProviderOptions extends PerceptionProviderOptions {
  endpointUrl: string;
  timeoutMs?: number;
  context?: ToolContext;
}

type ParsedContent = Record<string, unknown>;

interface OmniParserResponse {
  parsed_content_list?: unknown;
  som_image_base64?: unknown;
  latency?: unknown;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ELEMENTS = 200;
const DEFAULT_MAX_LABEL_LENGTH = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeTimeoutMs(timeoutMs: number | undefined, context?: ToolContext): number {
  const configured = Math.max(1, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!context) return configured;
  return Math.max(1, Math.min(configured, getRemainingBudget(context)));
}

function resolveLabel(item: ParsedContent): string {
  for (const key of ['content', 'label', 'text', 'caption', 'description']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return typeof item.type === 'string' ? item.type : '';
}

function resolveInteractive(item: ParsedContent): boolean | 'unknown' {
  for (const key of ['interactive', 'interactivity', 'is_interactive']) {
    if (typeof item[key] === 'boolean') return item[key];
  }
  return 'unknown';
}

function resolveType(item: ParsedContent, interactive: boolean | 'unknown'): PerceptionElement['type'] {
  const raw = String(item.type || item.element_type || '').toLowerCase();
  if (raw.includes('text')) return 'text';
  if (raw.includes('icon')) return interactive === true ? 'control' : 'icon';
  if (raw.includes('image') || raw.includes('img')) return 'image';
  if (interactive === true || raw.includes('button') || raw.includes('control')) return 'control';
  return 'unknown';
}

function resolveBBox(item: ParsedContent, viewport: { width: number; height: number }): PerceptionElement['bbox'] | undefined {
  const raw = item.bbox ?? item.box ?? item.bounding_box;
  let x: number | undefined;
  let y: number | undefined;
  let width: number | undefined;
  let height: number | undefined;

  if (Array.isArray(raw) && raw.length >= 4) {
    const nums = raw.slice(0, 4).map(finiteNumber);
    if (nums.every((n): n is number => n !== undefined)) {
      const [a, b, c, d] = nums;
      const ratio = nums.every(n => n >= 0 && n <= 1);
      x = ratio ? a * viewport.width : a;
      y = ratio ? b * viewport.height : b;
      width = ratio ? (c - a) * viewport.width : c - a;
      height = ratio ? (d - b) * viewport.height : d - b;
    }
  } else if (isRecord(raw)) {
    const rx = finiteNumber(raw.x);
    const ry = finiteNumber(raw.y);
    const rw = finiteNumber(raw.width ?? raw.w);
    const rh = finiteNumber(raw.height ?? raw.h);
    const x1 = finiteNumber(raw.x1 ?? raw.left);
    const y1 = finiteNumber(raw.y1 ?? raw.top);
    const x2 = finiteNumber(raw.x2 ?? raw.right);
    const y2 = finiteNumber(raw.y2 ?? raw.bottom);
    const values = [rx, ry, rw, rh, x1, y1, x2, y2].filter((n): n is number => n !== undefined);
    const ratio = values.length > 0 && values.every(n => n >= 0 && n <= 1);
    if (rx !== undefined && ry !== undefined && rw !== undefined && rh !== undefined) {
      x = ratio ? rx * viewport.width : rx;
      y = ratio ? ry * viewport.height : ry;
      width = ratio ? rw * viewport.width : rw;
      height = ratio ? rh * viewport.height : rh;
    } else if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
      x = ratio ? x1 * viewport.width : x1;
      y = ratio ? y1 * viewport.height : y1;
      width = ratio ? (x2 - x1) * viewport.width : x2 - x1;
      height = ratio ? (y2 - y1) * viewport.height : y2 - y1;
    }
  }

  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  const cx = clamp(x, 0, viewport.width);
  const cy = clamp(y, 0, viewport.height);
  return {
    x: cx,
    y: cy,
    width: clamp(width, 0, viewport.width - cx),
    height: clamp(height, 0, viewport.height - cy),
  };
}

function bboxRatio(bbox: PerceptionElement['bbox'], viewport: { width: number; height: number }): PerceptionElement['bboxRatio'] {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  return {
    x: clamp(bbox.x / width, 0, 1),
    y: clamp(bbox.y / height, 0, 1),
    width: clamp(bbox.width / width, 0, 1),
    height: clamp(bbox.height / height, 0, 1),
  };
}

export class OmniParserHttpProvider {
  readonly name = 'omniparser-http';

  constructor(private readonly page: Page, private readonly options: OmniParserHttpProviderOptions) {}

  async capture(tabId: string, url: string): Promise<PerceptionSnapshot> {
    const started = Date.now();
    const viewport = await resolveViewportDimensions(this.page);
    const areaError = validateCaptureArea(viewport, 'OmniParser screenshot');
    if (areaError) throw new Error(areaError);

    const timeoutMs = normalizeTimeoutMs(this.options.timeoutMs, this.options.context);
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.options.context?.signal?.reason ?? new Error('Tool call aborted'));
    this.options.context?.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`OmniParser HTTP provider timed out after ${timeoutMs}ms`)), timeoutMs);

    try {
      const screenshot = await this.captureScreenshot(Math.min(timeoutMs, DEFAULT_SCREENSHOT_TIMEOUT_MS));
      const response = await fetch(this.options.endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base64_image: screenshot.data }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OmniParser HTTP provider returned ${response.status}`);
      }

      const body = await response.json() as OmniParserResponse;
      return this.toSnapshot(body, tabId, url, viewport, started, screenshot.mimeType);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason || 'OmniParser HTTP provider aborted'));
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.options.context?.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async captureScreenshot(timeoutMs: number): Promise<{ data: string; mimeType: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffer = await Promise.race([
      this.page.screenshot({ type: 'webp', quality: DEFAULT_SCREENSHOT_QUALITY, fullPage: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OmniParser screenshot timed out')), timeoutMs);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });

    const encoded = bufferToBase64WithPayloadGuard(Buffer.from(buffer), 'OmniParser screenshot');
    if ('error' in encoded) throw new Error(encoded.error);
    return { data: encoded.data, mimeType: 'image/webp' };
  }

  private toSnapshot(
    body: OmniParserResponse,
    tabId: string,
    url: string,
    viewport: { width: number; height: number },
    started: number,
    screenshotMimeType: string
  ): PerceptionSnapshot {
    if (!Array.isArray(body.parsed_content_list)) {
      throw new Error('Malformed OmniParser response: parsed_content_list must be an array');
    }

    const warnings: string[] = [];
    const maxElements = Math.max(0, this.options.maxElements ?? DEFAULT_MAX_ELEMENTS);
    const maxLabelLength = this.options.maxLabelLength ?? DEFAULT_MAX_LABEL_LENGTH;
    const entries = body.parsed_content_list.filter(isRecord);
    if (body.parsed_content_list.length !== entries.length) {
      warnings.push('Malformed OmniParser entries were ignored.');
    }
    if (entries.length > maxElements) {
      warnings.push(`OmniParser snapshot truncated from ${entries.length} to ${maxElements} elements.`);
    }

    const elements: PerceptionElement[] = [];
    for (const item of entries.slice(0, maxElements)) {
      const bbox = resolveBBox(item, viewport);
      if (!bbox) {
        warnings.push('OmniParser entry without a valid bbox was ignored.');
        continue;
      }
      const interactive = resolveInteractive(item);
      const type = resolveType(item, interactive);
      elements.push({
        id: `op${elements.length + 1}`,
        type,
        label: sanitizePerceptionLabel(resolveLabel(item), maxLabelLength),
        role: typeof item.type === 'string' ? item.type : undefined,
        interactive,
        bbox,
        bboxRatio: bboxRatio(bbox, viewport),
        confidence: finiteNumber(item.confidence ?? item.score),
        source: this.name,
        metadata: typeof item.source === 'string' ? { upstreamSource: item.source } : undefined,
      });
    }

    return {
      version: 1,
      provider: this.name,
      tabId,
      url,
      capturedAt: started,
      viewport,
      screenshotMimeType,
      elements,
      warnings,
      latencyMs: finiteNumber(body.latency) ?? Date.now() - started,
    };
  }
}
