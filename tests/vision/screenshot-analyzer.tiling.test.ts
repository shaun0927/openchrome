/// <reference types="jest" />
/**
 * Tests for tiled mode in screenshot-analyzer (#853).
 *
 * Key acceptance criteria:
 *   - 3-viewport-tall page → result.tiling.tiles.length === 3
 *   - result.tiling.tileCount === 3
 *   - element y-coordinates are monotonically increasing across tiles
 *   - original scroll position is restored after analysis
 */

import { analyzeScreenshot } from '../../src/vision/screenshot-analyzer';

// ─── Mock page factory for tiling ───

/**
 * Creates a mock page that simulates a 3-viewport-tall document.
 *
 * page.evaluate() call signatures used by analyzeTiledScreenshot:
 *
 *   1. metrics (0 extra args):
 *        → { scrollX, scrollY, innerWidth, innerHeight, documentHeight }
 *
 *   2. scroll to tileTop (fn, tileTop number):
 *        → void
 *
 *   3. element collection per tile (fn, interactiveOnly bool, occlusionFilter bool):
 *        → { elements: [...], occludedDropped: 0 }
 *        (elements returned vary per tile — caller supplies perTileElements[])
 *
 *   4. overlay inject (fn, elems[], opts{}, overlayId string) — overlayId contains 'oc_vision'
 *        → void
 *
 *   5. overlay remove (fn, overlayId string) — overlayId contains 'oc_vision'
 *        → void
 *
 *   6. scroll restore (fn, originalX, originalY) — 2 number args after fn
 *        → void
 *
 * The factory tracks which tileTop values were scrolled to, and the final
 * scroll-restore call, so tests can assert correct behavior.
 */
function createTilingMockPage(opts: {
  viewportWidth?: number;
  viewportHeight?: number;
  documentHeight?: number;
  originalScrollX?: number;
  originalScrollY?: number;
  /** Elements returned for each tile by index (0-based). Cycled if fewer entries than tiles. */
  perTileElements?: Array<Array<{ role: string; name: string; x: number; y: number; width: number; height: number }>>;
}) {
  const vw = opts.viewportWidth ?? 1920;
  const vh = opts.viewportHeight ?? 768;
  const docH = opts.documentHeight ?? vh * 3;
  const origScrollX = opts.originalScrollX ?? 0;
  const origScrollY = opts.originalScrollY ?? 0;
  const perTile = opts.perTileElements ?? [[]];

  const scrollHistory: number[] = [];
  let tileCallCount = 0;

  const page = {
    evaluate: jest.fn().mockImplementation((_fn: Function, ...args: unknown[]) => {
      // Overlay inject: (fn, elems[], opts{}, overlayId)
      if (args.length === 3 && typeof args[2] === 'string' && String(args[2]).includes('oc_vision')) {
        return Promise.resolve();
      }
      // Overlay remove: (fn, overlayId)
      if (args.length === 1 && typeof args[0] === 'string' && String(args[0]).includes('oc_vision')) {
        return Promise.resolve();
      }
      // 0-arg: page metrics
      if (args.length === 0) {
        return Promise.resolve({
          scrollX: origScrollX,
          scrollY: origScrollY,
          innerWidth: vw,
          innerHeight: vh,
          documentHeight: docH,
        });
      }
      // Scroll-to call: (fn, tileTop) — single number arg
      if (args.length === 1 && typeof args[0] === 'number') {
        scrollHistory.push(args[0] as number);
        return Promise.resolve();
      }
      // Scroll-restore call: (fn, x, y) — two number args
      if (args.length === 2 && typeof args[0] === 'number' && typeof args[1] === 'number') {
        scrollHistory.push(args[1] as number); // record restoreY
        return Promise.resolve();
      }
      // Element collection: (fn, interactiveOnly, occlusionFilter)
      const elements = perTile[tileCallCount % perTile.length] ?? [];
      tileCallCount++;
      return Promise.resolve({ elements, occludedDropped: 0 });
    }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-tile-screenshot')),
    viewport: jest.fn().mockReturnValue({ width: vw, height: vh }),
    // iframes not used in tiling-only tests
    mainFrame: jest.fn().mockReturnValue({
      url: () => 'https://example.com/',
      childFrames: () => [],
      parentFrame: () => null,
    }),
    frames: jest.fn().mockReturnValue([]),
  };

  return { page, scrollHistory };
}

// ─── Tests ───

describe('analyzeScreenshot — tiled mode', () => {
  it('3-viewport-tall page produces 3 tiles and tileCount === 3', async () => {
    const vh = 768;
    const { page } = createTilingMockPage({
      viewportHeight: vh,
      documentHeight: vh * 3,
    });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    expect(result.tiling).toBeDefined();
    expect(result.tiling!.tileCount).toBe(3);
    expect(result.tiling!.tiles).toHaveLength(3);
  });

  it('tile tileTop values are 0, vh, 2*vh', async () => {
    const vh = 600;
    const { page } = createTilingMockPage({
      viewportHeight: vh,
      documentHeight: vh * 3,
    });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    const tops = result.tiling!.tiles.map(t => t.tileTop);
    expect(tops).toEqual([0, vh, vh * 2]);
  });

  it('element y-coordinates are monotonically non-decreasing across tiles', async () => {
    const vh = 500;
    // Each tile returns one element near the top of the tile viewport (local y=10).
    // After translation, tile0 y=10, tile1 y=510, tile2 y=1010.
    const perTileElements = [
      [{ role: 'button', name: 'T0', x: 10, y: 10, width: 80, height: 30 }],
      [{ role: 'button', name: 'T1', x: 10, y: 10, width: 80, height: 30 }],
      [{ role: 'button', name: 'T2', x: 10, y: 10, width: 80, height: 30 }],
    ];

    const { page } = createTilingMockPage({
      viewportHeight: vh,
      documentHeight: vh * 3,
      perTileElements,
    });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    const centerYs = Object.values(result.elementMap).map(e => e.centerY);
    expect(centerYs).toHaveLength(3);

    // Monotonically non-decreasing
    for (let i = 1; i < centerYs.length; i++) {
      expect(centerYs[i]).toBeGreaterThanOrEqual(centerYs[i - 1]);
    }
  });

  it('restores original scroll position after analysis', async () => {
    const vh = 800;
    const originalScrollY = 42;
    const { page, scrollHistory } = createTilingMockPage({
      viewportHeight: vh,
      documentHeight: vh * 3,
      originalScrollY,
    });

    await analyzeScreenshot(page as any, { mode: 'tiled' });

    // The last scroll-related call must restore to the original scroll position.
    // scrollHistory contains [0, vh, 2*vh, ..., originalScrollY (restore)].
    const lastScroll = scrollHistory[scrollHistory.length - 1];
    expect(lastScroll).toBe(originalScrollY);
  });

  it('first tile imageBase64 is used as top-level screenshot for backward compat', async () => {
    const vh = 600;
    const { page } = createTilingMockPage({ viewportHeight: vh, documentHeight: vh * 3 });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    // Top-level screenshot == first tile's imageBase64
    expect(result.screenshot).toBe(result.tiling!.tiles[0].imageBase64);
    expect(result.screenshot).toBeTruthy();
  });

  it('each tile carries imageBase64 and mimeType', async () => {
    const vh = 400;
    const { page } = createTilingMockPage({ viewportHeight: vh, documentHeight: vh * 3 });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    for (const tile of result.tiling!.tiles) {
      expect(tile.imageBase64).toBeTruthy();
      expect(tile.mimeType).toMatch(/^image\//);
    }
  });

  it('tileHeight equals the viewport height', async () => {
    const vh = 720;
    const { page } = createTilingMockPage({ viewportHeight: vh, documentHeight: vh * 3 });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    expect(result.tiling!.tileHeight).toBe(vh);
  });

  it('page-shorter-than-viewport produces exactly 1 tile', async () => {
    const vh = 900;
    const { page } = createTilingMockPage({ viewportHeight: vh, documentHeight: 500 });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    expect(result.tiling!.tileCount).toBe(1);
    expect(result.tiling!.tiles).toHaveLength(1);
    expect(result.tiling!.truncated).toBe(false);
  });

  it('tiling.truncated is false for a normal 3-tile page', async () => {
    const vh = 600;
    const { page } = createTilingMockPage({ viewportHeight: vh, documentHeight: vh * 3 });

    const result = await analyzeScreenshot(page as any, { mode: 'tiled' });

    expect(result.tiling!.truncated).toBe(false);
    expect(result.tiling!.reason).toBeUndefined();
  });
});
