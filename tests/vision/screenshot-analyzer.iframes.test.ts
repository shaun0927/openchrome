/// <reference types="jest" />
/**
 * Tests for iframe coord translation in screenshot-analyzer (#853).
 *
 * Two scenarios from the acceptance criteria:
 *   1. same-origin via srcdoc  → collectFromFrames traverses it and returns
 *      elements with top-frame–translated coordinates.
 *   2. cross-origin via data:  → frame is placed in iframes.skipped with
 *      reason:'cross-origin'.
 */

import { analyzeScreenshot } from '../../src/vision/screenshot-analyzer';

// ─── Frame mock helpers ───

interface MockFrame {
  url: () => string;
  parentFrame: () => MockFrame | null;
  childFrames: () => MockFrame[];
  evaluate: jest.Mock;
  frameElement: jest.Mock;
  $$: jest.Mock;
  mainFrame?: undefined; // type guard
}

interface MockPage {
  evaluate: jest.Mock;
  screenshot: jest.Mock;
  viewport: jest.Mock;
  mainFrame: () => MockFrame;
  frames: () => MockFrame[];
}

/**
 * Build a mock child frame.
 *
 * @param frameUrl     - frame.url() return value (e.g. 'about:srcdoc')
 * @param parentFrame  - the parent frame reference
 * @param iframeBox    - bounding box of the <iframe> element in the parent doc
 * @param elements     - elements returned by frame.evaluate(collectInPage, ...)
 */
function createChildFrame(
  frameUrl: string,
  parentFrame: MockFrame,
  iframeBox: { x: number; y: number; width: number; height: number } | null,
  elements: Array<{ role: string; name: string; x: number; y: number; width: number; height: number }>
): MockFrame {
  // frameElement() returns a handle whose boundingBox() resolves to iframeBox.
  const frameElementHandle = iframeBox
    ? { boundingBox: jest.fn().mockResolvedValue(iframeBox), dispose: jest.fn().mockResolvedValue(undefined) }
    : null;

  const frame: MockFrame = {
    url: () => frameUrl,
    parentFrame: () => parentFrame,
    childFrames: () => [],
    evaluate: jest.fn().mockResolvedValue({ elements, occludedDropped: 0 }),
    frameElement: jest.fn().mockResolvedValue(frameElementHandle),
    $$: jest.fn().mockResolvedValue([]),
  };
  return frame;
}

/**
 * Build a mock top frame (mainFrame).
 */
function createTopFrame(topUrl: string, children: MockFrame[]): MockFrame {
  const frame: MockFrame = {
    url: () => topUrl,
    parentFrame: () => null,
    childFrames: () => children,
    evaluate: jest.fn().mockResolvedValue({ elements: [], occludedDropped: 0 }),
    frameElement: jest.fn().mockResolvedValue(null),
    $$: jest.fn().mockResolvedValue([]),
  };
  return frame;
}

/**
 * Build a mock Page for iframe tests.
 *
 * page.evaluate is dispatched:
 *   - 0-arg: viewport dimensions for resolveViewportDimensions
 *   - overlay inject/remove: void (detected by oc_vision_overlay in string arg)
 *   - top-frame element collection (fn + 2 booleans): returns topFrameElements
 */
function createMockPage(
  topFrame: MockFrame,
  allFrames: MockFrame[],
  topFrameElements: unknown = [],
  viewport = { width: 1920, height: 1080 }
): MockPage {
  return {
    evaluate: jest.fn().mockImplementation((_fn: Function, ...args: unknown[]) => {
      // Overlay inject: (fn, elems, opts, overlayId)
      if (args.length === 3 && typeof args[2] === 'string' && String(args[2]).includes('oc_vision')) {
        return Promise.resolve();
      }
      // Overlay remove: (fn, overlayId)
      if (args.length === 1 && typeof args[0] === 'string' && String(args[0]).includes('oc_vision')) {
        return Promise.resolve();
      }
      // 0-arg: resolveViewportDimensions fallback
      if (args.length === 0) {
        return Promise.resolve({ width: viewport.width, height: viewport.height });
      }
      // Top-frame element collection: (fn, interactiveOnly, occlusionFilter)
      return Promise.resolve(topFrameElements);
    }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
    viewport: jest.fn().mockReturnValue(viewport),
    mainFrame: () => topFrame,
    frames: () => allFrames,
  };
}

// ─── Tests ───

describe('analyzeScreenshot — iframe traversal', () => {
  // ── same-origin via srcdoc ──────────────────────────────────────────────

  describe('same-origin iframe (srcdoc)', () => {
    it('traverses srcdoc frame and translates element coords to top-frame space', async () => {
      // <iframe srcdoc="..."> sits at top-frame coords (100, 200).
      // Inside the iframe, a button is at local (10, 20).
      // Expected translated: x=110, y=220.
      const iframeBox = { x: 100, y: 200, width: 300, height: 150 };
      const iframeElements = [
        { role: 'button', name: 'Login', x: 10, y: 20, width: 80, height: 30 },
      ];

      const topUrl = 'https://example.com/';
      const topFrame = createTopFrame(topUrl, []); // children set after
      const child = createChildFrame('about:srcdoc', topFrame, iframeBox, iframeElements);
      // Wire topFrame's children
      (topFrame as any).childFrames = () => [child];

      const page = createMockPage(topFrame, [topFrame, child]);
      const result = await analyzeScreenshot(page as any, { iframes: 'same-origin' });

      // iframes info should show 1 traversed
      expect(result.iframes).toBeDefined();
      expect(result.iframes!.traversed).toHaveLength(1);
      expect(result.iframes!.skipped).toHaveLength(0);

      // Translated element must appear in the element map
      expect(result.elementCount).toBe(1);
      const el = result.elementMap[1];
      expect(el.x).toBe(110);   // 10 + 100
      expect(el.y).toBe(220);   // 20 + 200
      expect(el.name).toBe('Login');
    });

    it('adds top-frame elements plus translated iframe elements to unified map', async () => {
      const iframeBox = { x: 50, y: 300, width: 400, height: 200 };
      const iframeElements = [
        { role: 'textbox', name: 'Password', x: 5, y: 5, width: 120, height: 30 },
      ];
      const topFrameElements = { elements: [
        { role: 'button', name: 'Top Button', x: 10, y: 10, width: 100, height: 30 },
      ], occludedDropped: 0 };

      const topUrl = 'https://example.com/';
      const topFrame = createTopFrame(topUrl, []);
      const child = createChildFrame('about:srcdoc', topFrame, iframeBox, iframeElements);
      (topFrame as any).childFrames = () => [child];

      const page = createMockPage(topFrame, [topFrame, child], topFrameElements);
      const result = await analyzeScreenshot(page as any, { iframes: 'same-origin' });

      expect(result.elementCount).toBe(2);

      // Top-frame button at (10,10)
      const topEl = Object.values(result.elementMap).find(e => e.name === 'Top Button');
      expect(topEl).toBeDefined();
      expect(topEl!.x).toBe(10);
      expect(topEl!.y).toBe(10);

      // Iframe textbox translated to (55, 305)
      const iframeEl = Object.values(result.elementMap).find(e => e.name === 'Password');
      expect(iframeEl).toBeDefined();
      expect(iframeEl!.x).toBe(55);   // 5 + 50
      expect(iframeEl!.y).toBe(305);  // 5 + 300
    });
  });

  // ── cross-origin via data: page ─────────────────────────────────────────

  describe('cross-origin iframe', () => {
    it('skips cross-origin frame and reports it in iframes.skipped with reason cross-origin', async () => {
      // A data: page embeds https://example.com in an iframe.
      // The child frame has a different origin → must land in skipped.
      const topUrl = 'data:text/html,<html><body></body></html>';
      const topFrame = createTopFrame(topUrl, []);

      // The child frame's URL is https://example.com — cross-origin relative to data:
      const child = createChildFrame(
        'https://example.com/',
        topFrame,
        null, // boundingBox irrelevant — frame is skipped before evaluation
        []
      );
      (topFrame as any).childFrames = () => [child];

      const page = createMockPage(topFrame, [topFrame, child]);
      const result = await analyzeScreenshot(page as any, { iframes: 'all' });

      expect(result.iframes).toBeDefined();
      expect(result.iframes!.traversed).toHaveLength(0);
      expect(result.iframes!.skipped).toHaveLength(1);
      expect(result.iframes!.skipped[0].reason).toBe('cross-origin');
    });

    it('iframes:none (default) skips traversal entirely — iframes field absent', async () => {
      const topUrl = 'https://example.com/';
      const topFrame = createTopFrame(topUrl, []);
      const child = createChildFrame('about:srcdoc', topFrame, { x: 0, y: 0, width: 100, height: 100 }, []);
      (topFrame as any).childFrames = () => [child];

      const page = createMockPage(topFrame, [topFrame, child]);
      const result = await analyzeScreenshot(page as any); // default: iframes:'none'

      expect(result.iframes).toBeUndefined();
    });

    it('cross-origin frame: child.evaluate is never called', async () => {
      const topUrl = 'https://host.com/';
      const topFrame = createTopFrame(topUrl, []);
      const child = createChildFrame('https://other.com/', topFrame, null, []);
      (topFrame as any).childFrames = () => [child];

      const page = createMockPage(topFrame, [topFrame, child]);
      await analyzeScreenshot(page as any, { iframes: 'all' });

      // frame.evaluate must not have been called on the cross-origin frame
      expect(child.evaluate).not.toHaveBeenCalled();
    });
  });
});
