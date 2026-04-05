/**
 * Screenshot Analyzer — Annotated screenshot generation for vision-based element discovery.
 *
 * Generates annotated screenshots with numbered labels, bounding boxes, and optional
 * coordinate grid overlays. Elements are discovered via in-page evaluation and annotated
 * directly on the page using an injected overlay.
 *
 * Architecture:
 *   1. Collect interactive elements via page.evaluate()
 *   2. Inject overlay <div> with positioned labels + boxes
 *   3. Take screenshot (captures overlay)
 *   4. Remove overlay
 *   5. Return annotated screenshot + element map
 *
 * No external image libraries required — uses the browser's own rendering engine.
 */

import type { Page } from 'puppeteer-core';
import {
  DEFAULT_SCREENSHOT_QUALITY,
  DEFAULT_DOM_SETTLE_DELAY_MS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
} from '../config/defaults';
import type {
  AnnotationOptions,
  AnnotatedScreenshotResult,
  VisionElementMap,
} from './types';

/** Raw element collected from the page */
export interface RawElement {
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  backendDOMNodeId?: number;
}

/** Default annotation options */
const DEFAULT_OPTIONS: Required<AnnotationOptions> = {
  showNumbers: true,
  showBoundingBoxes: true,
  showGrid: false,
  gridSpacing: 100,
  format: 'webp',
  quality: DEFAULT_SCREENSHOT_QUALITY,
  interactiveOnly: true,
};

/** Overlay element ID — must not collide with page content */
const OVERLAY_ID = '__oc_vision_overlay__';

/**
 * Collect all interactive elements visible in the viewport.
 *
 * Uses in-page evaluation for maximum compatibility (works even when
 * AX tree is sparse or unavailable). Elements are filtered for visibility,
 * minimum size, and deduplication.
 */
export async function collectInteractiveElements(
  page: Page,
  interactiveOnly: boolean
): Promise<RawElement[]> {
  const elements: RawElement[] = await page.evaluate((filterInteractive: boolean) => {
    const INTERACTIVE_SELECTORS = [
      'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]', '[role="switch"]', '[role="slider"]',
      '[role="combobox"]', '[role="searchbox"]', '[role="textbox"]',
      '[role="listbox"]', '[role="option"]', '[role="treeitem"]',
      '[role="gridcell"]', '[role="columnheader"]', '[role="rowheader"]',
      '[role="scrollbar"]', '[role="spinbutton"]',
    ];

    const ALL_SELECTORS = filterInteractive
      ? INTERACTIVE_SELECTORS
      : [...INTERACTIVE_SELECTORS, '[role]', 'img', 'svg', 'video', 'canvas', 'h1', 'h2', 'h3', 'h4', 'p'];

    const results: Array<{
      role: string;
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    const seen = new Set<Element>();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    function resolveRole(el: Element): string {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el as HTMLInputElement).type || 'text';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        if (t === 'range') return 'slider';
        return 'textbox';
      }
      if (tag === 'img') return 'img';
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') return 'heading';
      return 'generic';
    }

    function resolveName(el: Element): string {
      return (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('placeholder') ||
        (el.textContent || '').trim().slice(0, 60) ||
        ''
      );
    }

    for (const selector of ALL_SELECTORS) {
      try {
        const matches = document.querySelectorAll(selector);
        for (let i = 0; i < matches.length; i++) {
          const el = matches[i];
          if (seen.has(el)) continue;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) continue;

          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (parseFloat(cs.opacity) < 0.1) continue;

          results.push({
            role: resolveRole(el),
            name: resolveName(el),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });

          if (results.length >= 500) break;
        }
      } catch {
        // Selector may throw on some pages
      }
      if (results.length >= 500) break;
    }

    return results;
  }, interactiveOnly);

  // Sort in reading order: group by rows (50px bands), then left-to-right
  return elements.sort((a, b) => {
    const rowA = Math.floor(a.y / 50);
    const rowB = Math.floor(b.y / 50);
    if (rowA !== rowB) return rowA - rowB;
    return a.x - b.x;
  });
}

/**
 * Build the vision element map from collected elements.
 */
export function buildElementMap(elements: RawElement[]): VisionElementMap {
  const map: VisionElementMap = {};

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const num = i + 1;
    map[num] = {
      number: num,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      centerX: Math.round(el.x + el.width / 2),
      centerY: Math.round(el.y + el.height / 2),
      type: el.role,
      name: el.name,
      backendDOMNodeId: el.backendDOMNodeId,
    };
  }

  return map;
}

/**
 * Inject annotation overlay onto the page and capture screenshot.
 * Overlay is always removed after capture, even on error.
 */
async function captureAnnotatedScreenshot(
  page: Page,
  elements: RawElement[],
  options: Required<AnnotationOptions>
): Promise<{ screenshot: string; mimeType: string }> {
  try {
    // Inject overlay with annotations
    await page.evaluate(
      (elems: Array<{ x: number; y: number; width: number; height: number }>, opts: {
        showGrid: boolean; gridSpacing: number;
        showBoundingBoxes: boolean; showNumbers: boolean;
      }, id: string) => {
        document.getElementById(id)?.remove();

        const overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText =
          'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
          'pointer-events:none;z-index:2147483647;overflow:visible;';

        if (opts.showGrid) {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const canvas = document.createElement('canvas');
          canvas.width = vw;
          canvas.height = vh;
          canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.strokeStyle = 'rgba(0,150,255,0.15)';
            ctx.lineWidth = 1;
            ctx.font = '10px monospace';
            ctx.fillStyle = 'rgba(0,150,255,0.4)';
            for (let x = 0; x < vw; x += opts.gridSpacing) {
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, vh); ctx.stroke();
              ctx.fillText(String(x), x + 2, 12);
            }
            for (let y = 0; y < vh; y += opts.gridSpacing) {
              ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(vw, y); ctx.stroke();
              ctx.fillText(String(y), 2, y - 2);
            }
          }
          overlay.appendChild(canvas);
        }

        for (let i = 0; i < elems.length; i++) {
          const el = elems[i];
          const num = i + 1;

          if (opts.showBoundingBoxes) {
            const box = document.createElement('div');
            box.style.cssText =
              'position:fixed;' +
              'left:' + el.x + 'px;top:' + el.y + 'px;' +
              'width:' + el.width + 'px;height:' + el.height + 'px;' +
              'border:2px solid rgba(255,50,50,0.7);' +
              'background:rgba(255,50,50,0.05);box-sizing:border-box;';
            overlay.appendChild(box);
          }

          if (opts.showNumbers) {
            const label = document.createElement('div');
            const sz = num >= 100 ? 22 : num >= 10 ? 18 : 16;
            label.style.cssText =
              'position:fixed;' +
              'left:' + (el.x - 2) + 'px;top:' + (el.y - sz - 2) + 'px;' +
              'min-width:' + sz + 'px;height:' + sz + 'px;' +
              'background:rgba(255,50,50,0.9);color:#fff;' +
              'font:bold ' + Math.max(10, sz - 4) + 'px/1 monospace;' +
              'display:flex;align-items:center;justify-content:center;' +
              'border-radius:2px;padding:0 3px;' +
              'text-shadow:0 0 2px rgba(0,0,0,0.5);';
            label.textContent = String(num);
            overlay.appendChild(label);
          }
        }

        document.documentElement.appendChild(overlay);
      },
      elements.map(el => ({ x: el.x, y: el.y, width: el.width, height: el.height })),
      {
        showGrid: options.showGrid,
        gridSpacing: options.gridSpacing,
        showBoundingBoxes: options.showBoundingBoxes,
        showNumbers: options.showNumbers,
      },
      OVERLAY_ID
    );

    await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffer = await Promise.race([
      page.screenshot({
        type: options.format,
        quality: options.format === 'png' ? undefined : options.quality,
        fullPage: false,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Screenshot timed out')), DEFAULT_SCREENSHOT_TIMEOUT_MS);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });

    const screenshotBuffer = Buffer.from(buffer);
    const mimeType = options.format === 'webp' ? 'image/webp' : 'image/png';

    return {
      screenshot: screenshotBuffer.toString('base64'),
      mimeType,
    };
  } finally {
    await page.evaluate((id: string) => {
      document.getElementById(id)?.remove();
    }, OVERLAY_ID).catch(() => {});
  }
}

/**
 * Generate an annotated screenshot with numbered elements and bounding boxes.
 *
 * @param page - Puppeteer page instance
 * @param options - Annotation options
 * @returns Annotated screenshot result with element map
 */
export async function analyzeScreenshot(
  page: Page,
  options?: AnnotationOptions
): Promise<AnnotatedScreenshotResult> {
  const startTime = Date.now();
  const opts: Required<AnnotationOptions> = { ...DEFAULT_OPTIONS, ...options };

  const elements = await collectInteractiveElements(page, opts.interactiveOnly);
  const elementMap = buildElementMap(elements);
  const { screenshot, mimeType } = await captureAnnotatedScreenshot(page, elements, opts);
  const viewport = page.viewport() || { width: 1920, height: 1080 };

  return {
    screenshot,
    mimeType,
    elementMap,
    elementCount: elements.length,
    viewport: { width: viewport.width, height: viewport.height },
    annotationTimeMs: Date.now() - startTime,
  };
}

/**
 * Format element map as a compact text description for non-vision models.
 */
export function formatElementMapAsText(elementMap: VisionElementMap): string {
  const entries = Object.values(elementMap);
  if (entries.length === 0) return 'No interactive elements found.';

  const lines = entries.map(el =>
    `[${el.number}] ${el.type}: "${el.name}" at (${el.centerX}, ${el.centerY}) ${el.width}x${el.height}`
  );

  return `${entries.length} interactive elements:\n${lines.join('\n')}`;
}
