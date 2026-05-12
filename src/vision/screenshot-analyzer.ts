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

import type { Frame, Page } from 'puppeteer-core';
import {
  DEFAULT_SCREENSHOT_QUALITY,
  DEFAULT_DOM_SETTLE_DELAY_MS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
} from '../config/defaults';
import type {
  AnnotationOptions,
  AnnotatedScreenshotResult,
  VisionElementMap,
  VisionIframesInfo,
  VisionTile,
  VisionTilingInfo,
} from './types';
import { bufferToBase64WithPayloadGuard, resolveViewportDimensions, validateCaptureArea } from '../utils/screenshot-guards';

/** Raw element collected from the page */
export interface RawElement {
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  backendDOMNodeId?: number;
  /** Optional frame metadata when collected from an iframe. */
  frame?: { frameId: string; origin: string };
}

/** Default annotation options */
const DEFAULT_OPTIONS: Required<Omit<AnnotationOptions, 'occlusionFilter' | 'iframes' | 'mode'>> & {
  occlusionFilter: boolean;
  iframes: NonNullable<AnnotationOptions['iframes']>;
  mode: NonNullable<AnnotationOptions['mode']>;
} = {
  showNumbers: true,
  showBoundingBoxes: true,
  showGrid: false,
  gridSpacing: 100,
  format: 'webp',
  quality: DEFAULT_SCREENSHOT_QUALITY,
  interactiveOnly: true,
  occlusionFilter: false,
  iframes: 'none',
  mode: 'viewport',
};

/** Overlay element ID — must not collide with page content */
const OVERLAY_ID = '__oc_vision_overlay__';

/** Hard caps for tiled mode (per spec). */
const TILED_MAX_TILES = 20;
const TILED_MAX_ELEMENTS = 1500;
const TILED_MAX_PIXELS = 16_000_000;

/** Hard caps for iframe traversal. */
const IFRAME_MAX_DEPTH = 4;
const IFRAME_MAX_COUNT = 20;

/**
 * In-page collection function. Defined as a string-serializable function so that it can be
 * invoked uniformly via `page.evaluate` on the top frame and `frame.evaluate` for iframes.
 *
 * Returns rects in the frame's local viewport coordinates. The caller is responsible for
 * translating to top-frame document coordinates when collected from an iframe.
 */
function collectInPage(filterInteractive: boolean, occlusionFilter: boolean): {
  elements: Array<{ role: string; name: string; x: number; y: number; width: number; height: number }>;
  occludedDropped: number;
} {
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
  let occludedDropped = 0;

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

        // Occlusion filter: drop elements whose center is covered by an unrelated element.
        if (occlusionFilter) {
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          // Skip the check if the center is outside the viewport — elementFromPoint
          // returns null in that case, which would over-aggressively drop valid elements.
          if (cx >= 0 && cy >= 0 && cx <= vw && cy <= vh) {
            const hit = document.elementFromPoint(cx, cy);
            if (!hit) {
              occludedDropped++;
              continue;
            }
            const isSelfOrRelated = hit === el || el.contains(hit) || hit.contains(el);
            if (!isSelfOrRelated) {
              occludedDropped++;
              continue;
            }
          }
        }

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

  return { elements: results, occludedDropped };
}

/**
 * Collect all interactive elements visible in the viewport.
 *
 * Uses in-page evaluation for maximum compatibility (works even when
 * AX tree is sparse or unavailable). Elements are filtered for visibility,
 * minimum size, and deduplication.
 *
 * When `occlusionFilter` is true, additionally drops elements whose center pixel
 * resolves (via `document.elementFromPoint`) to an unrelated element — i.e. covered
 * by a fixed/sticky overlay, modal, banner, etc.
 *
 * Backward-compat: the legacy 2-arg signature returns `RawElement[]` (sorted reading order).
 * The 3-arg signature returns `{ elements, occludedDropped }` to surface the dropped count.
 */
export async function collectInteractiveElements(
  page: Page,
  interactiveOnly: boolean
): Promise<RawElement[]>;
export async function collectInteractiveElements(
  page: Page,
  interactiveOnly: boolean,
  occlusionFilter: boolean
): Promise<{ elements: RawElement[]; occludedDropped: number }>;
export async function collectInteractiveElements(
  page: Page,
  interactiveOnly: boolean,
  occlusionFilter?: boolean
): Promise<RawElement[] | { elements: RawElement[]; occludedDropped: number }> {
  const wantsCount = occlusionFilter !== undefined;
  const flag = occlusionFilter === true;

  const raw = await page.evaluate(collectInPage, interactiveOnly, flag);
  // Tolerate legacy mocks that return a bare array.
  const elements = Array.isArray(raw)
    ? (raw as Array<{ role: string; name: string; x: number; y: number; width: number; height: number }>)
    : raw.elements;
  const occludedDropped = Array.isArray(raw) ? 0 : raw.occludedDropped;

  const sorted = elements.slice().sort((a, b) => {
    const rowA = Math.floor(a.y / 50);
    const rowB = Math.floor(b.y / 50);
    if (rowA !== rowB) return rowA - rowB;
    return a.x - b.x;
  });

  if (wantsCount) {
    return { elements: sorted, occludedDropped };
  }
  return sorted;
}

/**
 * Classify a frame's origin relative to the top frame.
 *
 * - `about:srcdoc` → same-origin (inherits parent origin per HTML spec)
 * - `about:blank` → same-origin if parent is same-origin to top, else cross-origin
 * - Otherwise compare URL origins
 */
function classifyFrameOrigin(frame: Frame, topOrigin: string): { origin: string; sameOrigin: boolean } {
  const url = frame.url();

  if (url === 'about:srcdoc') {
    return { origin: topOrigin, sameOrigin: true };
  }

  if (url === 'about:blank') {
    const parent = frame.parentFrame();
    if (!parent) {
      return { origin: topOrigin, sameOrigin: true };
    }
    const parentUrl = parent.url();
    if (parentUrl === 'about:blank' || parentUrl === 'about:srcdoc') {
      return { origin: topOrigin, sameOrigin: true };
    }
    try {
      const parentOrigin = new URL(parentUrl).origin;
      return { origin: parentOrigin, sameOrigin: parentOrigin === topOrigin };
    } catch {
      return { origin: 'about:blank', sameOrigin: false };
    }
  }

  try {
    const origin = new URL(url).origin;
    return { origin, sameOrigin: origin === topOrigin };
  } catch {
    return { origin: url, sameOrigin: false };
  }
}

/**
 * Compute the top-frame offset of a frame from its immediate `<iframe>` host
 * element's bounding box.
 *
 * P1-fix (codex review on #932): Puppeteer's `ElementHandle.boundingBox()` already
 * returns coordinates **relative to the main frame** (see puppeteer docs:
 * "boundingBox(): Promise<BoundingBox|null> — top-left position relative to the main frame").
 * Walking up parent frames and summing each ancestor iframe's box double-counts the
 * outer iframe offsets for any frame at depth > 1. The correct offset for any frame
 * is the main-frame-relative box of its own host `<iframe>` element.
 *
 * Primary path: `frame.frameElement()` (puppeteer-core ≥ 22).
 * Fallback: `parentFrame.childFrames().indexOf(frame)` → index into `parent.$$('iframe,frame')`.
 *
 * Returns null if the offset cannot be determined (e.g. cross-origin parent, missing element).
 */
async function computeFrameOffset(frame: Frame): Promise<{ x: number; y: number } | null> {
  const parent = frame.parentFrame();
  if (!parent) {
    // Top-level frame — no offset.
    return { x: 0, y: 0 };
  }

  let box: { x: number; y: number; width: number; height: number } | null = null;

  // Primary: frame.frameElement() returns the host <iframe>; its boundingBox
  // is already in main-frame coordinates per puppeteer-core semantics.
  try {
    const handle = await frame.frameElement();
    if (handle) {
      try {
        box = await handle.boundingBox();
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
  } catch {
    // Fall through to indexed fallback.
  }

  // Fallback: index into parent's iframe/frame elements.
  if (!box) {
    try {
      const siblings = parent.childFrames();
      const idx = siblings.indexOf(frame);
      if (idx >= 0) {
        const elementHandles = await parent.$$('iframe,frame');
        try {
          if (idx < elementHandles.length) {
            box = await elementHandles[idx].boundingBox();
          }
        } finally {
          await Promise.all(elementHandles.map(h => h.dispose().catch(() => {})));
        }
      }
    } catch {
      // Both paths failed — cannot translate coordinates.
    }
  }

  if (!box) {
    return null;
  }

  return { x: box.x, y: box.y };
}

/**
 * Traverse frames BFS from the top, collecting interactive elements with translated
 * top-frame coordinates. Respects depth and count caps.
 *
 * @param page - puppeteer Page
 * @param mode - 'same-origin' | 'all' (caller guarantees mode !== 'none')
 * @param interactiveOnly - propagated to collector
 * @param occlusionFilter - propagated to collector (evaluated in each frame's own viewport)
 * @returns translated elements + traversal/skip info
 */
async function collectFromFrames(
  page: Page,
  mode: 'same-origin' | 'all',
  interactiveOnly: boolean,
  occlusionFilter: boolean
): Promise<{ elements: RawElement[]; iframes: VisionIframesInfo; occludedDropped: number }> {
  const info: VisionIframesInfo = { traversed: [], skipped: [] };
  const collected: RawElement[] = [];
  let occludedDropped = 0;

  const topFrame = page.mainFrame();
  let topOrigin: string;
  try {
    topOrigin = new URL(topFrame.url()).origin;
  } catch {
    topOrigin = topFrame.url();
  }

  // BFS over child frames with depth tracking.
  type QueueEntry = { frame: Frame; depth: number };
  const queue: QueueEntry[] = topFrame.childFrames().map(f => ({ frame: f, depth: 1 }));
  let visited = 0;

  while (queue.length > 0) {
    const { frame, depth } = queue.shift()!;
    const { origin, sameOrigin } = classifyFrameOrigin(frame, topOrigin);

    if (depth > IFRAME_MAX_DEPTH) {
      info.skipped.push({ origin, reason: 'depth-cap' });
      continue;
    }

    if (visited >= IFRAME_MAX_COUNT) {
      info.skipped.push({ origin, reason: 'count-cap' });
      continue;
    }

    if (!sameOrigin) {
      // Both 'same-origin' and 'all' report cross-origin frames — only 'all' could in principle
      // attempt to evaluate, but puppeteer-core cannot evaluate into cross-origin frames.
      info.skipped.push({ origin, reason: 'cross-origin' });
      continue;
    }

    visited++;

    let frameResult: { elements: Array<{ role: string; name: string; x: number; y: number; width: number; height: number }>; occludedDropped: number };
    try {
      frameResult = await frame.evaluate(collectInPage, interactiveOnly, occlusionFilter);
    } catch {
      // Frame may have detached mid-traversal — skip silently.
      continue;
    }

    const offset = await computeFrameOffset(frame);
    if (!offset) {
      // Cannot translate coordinates — skip this frame's elements but still descend.
      info.skipped.push({ origin, reason: 'cross-origin' });
    } else {
      // puppeteer-core Frame has no public id; the URL uniquely identifies a frame within a page.
      const frameId = frame.url();
      for (const el of frameResult.elements) {
        collected.push({
          role: el.role,
          name: el.name,
          x: Math.round(el.x + offset.x),
          y: Math.round(el.y + offset.y),
          width: el.width,
          height: el.height,
          frame: { frameId, origin },
        });
      }
      occludedDropped += frameResult.occludedDropped;
      info.traversed.push({ frameId, origin, elementCount: frameResult.elements.length });
    }

    // Descend into children.
    for (const child of frame.childFrames()) {
      queue.push({ frame: child, depth: depth + 1 });
    }
  }

  // Suppress the mode parameter unused warning when mode === 'same-origin' — it is structurally
  // the same as 'all' for puppeteer-core (cross-origin frames are never evaluable).
  void mode;

  return { elements: collected, iframes: info, occludedDropped };
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
 *
 * @param elementsForOverlay - elements to annotate, with coordinates in the current viewport.
 *                             Tiled mode passes viewport-local coords here even though the
 *                             unified element map uses document-space coords.
 */
async function captureAnnotatedScreenshot(
  page: Page,
  elementsForOverlay: Array<{ x: number; y: number; width: number; height: number }>,
  options: { showGrid: boolean; gridSpacing: number; showBoundingBoxes: boolean; showNumbers: boolean; format: 'png' | 'webp'; quality: number },
  numberOffset: number = 0
): Promise<{ screenshot: string; mimeType: string; pixels: number }> {
  const viewport = await resolveViewportDimensions(page);
  const areaError = validateCaptureArea(viewport, 'Annotated screenshot');
  if (areaError) {
    throw new Error(areaError);
  }

  try {
    // Inject overlay with annotations
    await page.evaluate(
      (elems: Array<{ x: number; y: number; width: number; height: number }>, opts: {
        showGrid: boolean; gridSpacing: number;
        showBoundingBoxes: boolean; showNumbers: boolean;
        numberOffset: number;
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
          const num = opts.numberOffset + i + 1;

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
      elementsForOverlay.map(el => ({ x: el.x, y: el.y, width: el.width, height: el.height })),
      {
        showGrid: options.showGrid,
        gridSpacing: options.gridSpacing,
        showBoundingBoxes: options.showBoundingBoxes,
        showNumbers: options.showNumbers,
        numberOffset,
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
    const encoded = bufferToBase64WithPayloadGuard(screenshotBuffer, 'Annotated screenshot');
    if ('error' in encoded) {
      throw new Error(encoded.error);
    }
    const mimeType = options.format === 'webp' ? 'image/webp' : 'image/png';

    return {
      screenshot: encoded.data,
      mimeType,
      pixels: viewport.width * viewport.height,
    };
  } finally {
    await page.evaluate((id: string) => {
      document.getElementById(id)?.remove();
    }, OVERLAY_ID).catch(() => {});
  }
}

/**
 * Tiled mode: scroll the document in viewport-tall steps, capture each tile, translate
 * element coordinates to document space, and merge into a unified element list.
 *
 * Caps: 20 tiles, 1500 elements, 16 megapixels of total annotated pixels.
 * Restores original scroll position in a finally block.
 *
 * Iframe traversal (if requested) runs once at the end with the page in its restored
 * scroll position so iframe coords are not duplicated per tile.
 */
async function analyzeTiledScreenshot(
  page: Page,
  opts: typeof DEFAULT_OPTIONS
): Promise<{
  elements: RawElement[];
  tiling: VisionTilingInfo;
  occludedDropped: number;
  iframes?: VisionIframesInfo;
  iframeElements: RawElement[];
}> {
  // Read document and viewport metrics + original scroll.
  const metrics = await page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ),
  }));

  const originalScrollX = metrics.scrollX;
  const originalScrollY = metrics.scrollY;
  const viewportHeight = metrics.innerHeight || 1;
  const documentHeight = Math.max(metrics.documentHeight, viewportHeight);

  const tiles: VisionTile[] = [];
  const unifiedElements: RawElement[] = [];
  // Dedup keyed by (x, y, width, height, role, name) tuple.
  const seenKeys = new Set<string>();
  let occludedDropped = 0;
  let totalPixels = 0;
  let truncated = false;
  let truncatedReason: VisionTilingInfo['reason'] | undefined;

  try {
    for (let tileTop = 0; tileTop < documentHeight; tileTop += viewportHeight) {
      if (tiles.length >= TILED_MAX_TILES) {
        truncated = true;
        truncatedReason = 'tile-cap';
        break;
      }

      await page.evaluate((y: number) => window.scrollTo(0, y), tileTop);
      await new Promise(resolve => setTimeout(resolve, DEFAULT_DOM_SETTLE_DELAY_MS));

      // P1-fix (codex review on #932): `window.scrollTo(0, tileTop)` is clamped at
      // `documentElement.scrollHeight - innerHeight`. When the document height is not
      // an exact multiple of viewport height, the last tile's real scroll position is
      // less than `tileTop`. Translating with `tileTop` would inflate doc-space Y for
      // every element in that tile. Read the actual `window.scrollY` after the scroll
      // and use it as the document-space offset for both coord translation and the
      // tile record itself.
      const actualScrollY = await page.evaluate(() => window.scrollY);
      const docOffsetY = typeof actualScrollY === 'number' ? actualScrollY : tileTop;

      const result = await collectInteractiveElements(page, opts.interactiveOnly, opts.occlusionFilter);
      const rawList = Array.isArray(result) ? result : result.elements;
      const dropped = Array.isArray(result) ? 0 : result.occludedDropped;
      occludedDropped += dropped;

      // Translate to document space (y += docOffsetY). Dedup on identity tuple, keeping
      // the first occurrence (smallest tileTop where the element appeared).
      const translated: RawElement[] = [];
      for (const el of rawList) {
        const docY = el.y + docOffsetY;
        const key = `${el.x}|${docY}|${el.width}|${el.height}|${el.role}|${el.name}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        translated.push({ ...el, y: docY });
      }

      // P1 codex fix: detect element-cap *before* the capture so we know how
      // many elements actually go into this tile, but still capture the
      // screenshot before breaking out of the loop. Previously the cap break
      // happened before `captureAnnotatedScreenshot`, so when tile 1 alone
      // hit the cap, `tiles` stayed empty and `vision_find` returned an
      // empty/invalid screenshot payload.
      let capHit = false;
      if (unifiedElements.length + translated.length >= TILED_MAX_ELEMENTS) {
        const remaining = TILED_MAX_ELEMENTS - unifiedElements.length;
        if (remaining > 0) {
          translated.length = remaining; // truncate to the remaining budget
        } else {
          translated.length = 0;
        }
        capHit = true;
      }

      // Capture the annotated tile screenshot. Use viewport-local coords for the overlay,
      // but number labels are offset so they align with the unified map indices.
      const overlayElems = rawList.map(el => ({ x: el.x, y: el.y, width: el.width, height: el.height }));
      const numberOffset = unifiedElements.length;
      const captured = await captureAnnotatedScreenshot(
        page,
        overlayElems,
        {
          showGrid: opts.showGrid,
          gridSpacing: opts.gridSpacing,
          showBoundingBoxes: opts.showBoundingBoxes,
          showNumbers: opts.showNumbers,
          format: opts.format,
          quality: opts.quality,
        },
        numberOffset
      );

      totalPixels += captured.pixels;
      // P2 codex fix: record the *actual* post-scroll Y offset (`docOffsetY`)
      // rather than the requested `tileTop`. When the document height isn't an
      // exact multiple of the viewport height, the last scroll is clamped and
      // `tileTop` overstates the real position. Coordinate translation already
      // uses `docOffsetY`; using a different value in `tiles[i].tileTop` would
      // break downstream reconstruction.
      tiles.push({ tileTop: docOffsetY, imageBase64: captured.screenshot, mimeType: captured.mimeType });
      unifiedElements.push(...translated);

      // P1 codex fix (continued): if the element cap was reached this tile,
      // record the truncation reason and stop iterating *after* the capture.
      if (capHit) {
        truncated = true;
        truncatedReason = 'element-cap';
        break;
      }

      if (totalPixels >= TILED_MAX_PIXELS) {
        truncated = true;
        truncatedReason = 'mp-cap';
        break;
      }
    }
  } finally {
    // Always restore original scroll.
    await page.evaluate(
      (x: number, y: number) => window.scrollTo(x, y),
      originalScrollX,
      originalScrollY
    ).catch(() => {});
  }

  const tiling: VisionTilingInfo = {
    tileCount: tiles.length,
    tileHeight: viewportHeight,
    tiles,
    truncated,
    reason: truncatedReason,
  };

  // Iframe pass — only once, at end, against restored scroll position.
  let iframes: VisionIframesInfo | undefined;
  let iframeElements: RawElement[] = [];
  if (opts.iframes !== 'none') {
    const framesResult = await collectFromFrames(page, opts.iframes, opts.interactiveOnly, opts.occlusionFilter);
    iframes = framesResult.iframes;
    iframeElements = framesResult.elements;
    occludedDropped += framesResult.occludedDropped;
  }

  return { elements: unifiedElements, tiling, occludedDropped, iframes, iframeElements };
}

/**
 * Generate an annotated screenshot with numbered elements and bounding boxes.
 *
 * @param page - Puppeteer page instance
 * @param options - Annotation options (occlusionFilter, iframes, mode are purely additive
 *                  and default to values that preserve today's byte-identical output)
 * @returns Annotated screenshot result with element map
 */
export async function analyzeScreenshot(
  page: Page,
  options?: AnnotationOptions
): Promise<AnnotatedScreenshotResult> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options } as typeof DEFAULT_OPTIONS;

  const captureOpts = {
    showGrid: opts.showGrid,
    gridSpacing: opts.gridSpacing,
    showBoundingBoxes: opts.showBoundingBoxes,
    showNumbers: opts.showNumbers,
    format: opts.format,
    quality: opts.quality,
  };

  // ─── Tiled mode ───
  if (opts.mode === 'tiled') {
    const tiledResult = await analyzeTiledScreenshot(page, opts);
    const allElements = [...tiledResult.elements, ...tiledResult.iframeElements];
    const elementMap = buildElementMap(allElements);
    const viewport = page.viewport() || { width: 1920, height: 1080 };
    const firstTile = tiledResult.tiling.tiles[0];

    const result: AnnotatedScreenshotResult = {
      screenshot: firstTile?.imageBase64 ?? '',
      mimeType: firstTile?.mimeType ?? (opts.format === 'webp' ? 'image/webp' : 'image/png'),
      elementMap,
      elementCount: allElements.length,
      viewport: { width: viewport.width, height: viewport.height },
      annotationTimeMs: Date.now() - startTime,
      tiling: tiledResult.tiling,
    };
    if (opts.occlusionFilter) {
      result.occludedDropped = tiledResult.occludedDropped;
    }
    if (tiledResult.iframes) {
      result.iframes = tiledResult.iframes;
    }
    return result;
  }

  // ─── Viewport mode ───
  // Preserve byte-identity with the pre-#853 implementation when all new flags are off:
  // call collectInteractiveElements with the legacy 2-arg signature so existing test mocks
  // (which return a bare array from page.evaluate) keep working.
  let elements: RawElement[];
  let occludedDropped = 0;
  if (opts.occlusionFilter) {
    const result = await collectInteractiveElements(page, opts.interactiveOnly, true);
    elements = result.elements;
    occludedDropped = result.occludedDropped;
  } else {
    elements = await collectInteractiveElements(page, opts.interactiveOnly);
  }

  let iframeResult: { elements: RawElement[]; iframes: VisionIframesInfo; occludedDropped: number } | undefined;
  if (opts.iframes !== 'none') {
    iframeResult = await collectFromFrames(page, opts.iframes, opts.interactiveOnly, opts.occlusionFilter);
    elements = [...elements, ...iframeResult.elements];
    occludedDropped += iframeResult.occludedDropped;
  }

  const elementMap = buildElementMap(elements);
  // Use top-frame elements only for the overlay (iframe elements live in another doc).
  const overlayElems = elements
    .filter(el => !el.frame)
    .map(el => ({ x: el.x, y: el.y, width: el.width, height: el.height }));
  const { screenshot, mimeType } = await captureAnnotatedScreenshot(page, overlayElems, captureOpts);
  const viewport = page.viewport() || { width: 1920, height: 1080 };

  const result: AnnotatedScreenshotResult = {
    screenshot,
    mimeType,
    elementMap,
    elementCount: elements.length,
    viewport: { width: viewport.width, height: viewport.height },
    annotationTimeMs: Date.now() - startTime,
  };
  if (opts.occlusionFilter) {
    result.occludedDropped = occludedDropped;
  }
  if (iframeResult) {
    result.iframes = iframeResult.iframes;
  }
  return result;
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
