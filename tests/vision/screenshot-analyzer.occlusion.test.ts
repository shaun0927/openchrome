/// <reference types="jest" />
/**
 * Tests for occlusion filter in screenshot-analyzer (#853).
 *
 * Synthetic scenario: a fixed overlay (cookie banner / modal) sits on top of a
 * button. When occlusionFilter:true the button must be dropped and
 * result.occludedDropped must be >= 1. When occlusionFilter:false the button
 * survives. The field must be absent in the default (no-option) call.
 */

import { analyzeScreenshot } from '../../src/vision/screenshot-analyzer';

// ─── Mock Page Factory ───

/**
 * Returns a mock page whose evaluate() dispatches on call signature:
 *   - overlay inject/remove  → void  (detected by oc_vision_overlay in 3rd arg)
 *   - 0-arg evaluate         → live viewport dimensions
 *   - element collection     → returns the provided evaluateResult
 */
function createMockPage(
  evaluateResult: unknown,
  viewport: { width: number; height: number } = { width: 1920, height: 1080 }
) {
  return {
    evaluate: jest.fn().mockImplementation((_fn: Function, ...args: unknown[]) => {
      // Overlay inject: (fn, elems, opts, overlayId) — overlayId contains 'oc_vision'
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
      // Element collection: (fn, interactiveOnly, occlusionFilter)
      return Promise.resolve(evaluateResult);
    }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
    viewport: jest.fn().mockReturnValue(viewport),
  };
}

// ─── Tests ───

describe('analyzeScreenshot — occlusion filter', () => {
  it('occlusionFilter:true drops covered elements and sets occludedDropped >= 1', async () => {
    // Simulate: button is beneath an overlay → elementFromPoint returns the overlay,
    // not the button. The in-page collect function returns occludedDropped=1, elements=[].
    const page = createMockPage({ elements: [], occludedDropped: 1 });

    const result = await analyzeScreenshot(page as any, { occlusionFilter: true });

    expect(result.elementCount).toBe(0);
    expect(result.occludedDropped).toBeGreaterThanOrEqual(1);
  });

  it('occlusionFilter:false keeps covered elements and does not set occludedDropped', async () => {
    // With occlusion filtering off the button is returned normally.
    const button = { role: 'button', name: 'Accept', x: 100, y: 400, width: 120, height: 40 };
    const page = createMockPage({ elements: [button], occludedDropped: 0 });

    const result = await analyzeScreenshot(page as any, { occlusionFilter: false });

    expect(result.elementCount).toBe(1);
    expect(result.elementMap[1].name).toBe('Accept');
    // occludedDropped must not appear when filter is off
    expect(result.occludedDropped).toBeUndefined();
  });

  it('default call (no options) does not include occludedDropped field', async () => {
    const button = { role: 'button', name: 'Click Me', x: 50, y: 50, width: 80, height: 30 };
    // Legacy bare-array return is still accepted for backward-compat.
    const page = createMockPage([button]);

    const result = await analyzeScreenshot(page as any);

    expect(result.occludedDropped).toBeUndefined();
  });

  it('occludedDropped is 0 when filter is on but nothing is occluded', async () => {
    // Every element passes the elementFromPoint check → occludedDropped stays 0.
    const button = { role: 'button', name: 'Submit', x: 10, y: 10, width: 80, height: 30 };
    const page = createMockPage({ elements: [button], occludedDropped: 0 });

    const result = await analyzeScreenshot(page as any, { occlusionFilter: true });

    expect(result.elementCount).toBe(1);
    // The field IS present (filter was active) but its value is 0.
    expect(result.occludedDropped).toBe(0);
  });

  it('multiple elements partially occluded: count reflects only dropped ones', async () => {
    // 2 visible, 3 occluded
    const visible = [
      { role: 'button', name: 'A', x: 10, y: 10, width: 80, height: 30 },
      { role: 'link', name: 'B', x: 10, y: 60, width: 80, height: 20 },
    ];
    const page = createMockPage({ elements: visible, occludedDropped: 3 });

    const result = await analyzeScreenshot(page as any, { occlusionFilter: true });

    expect(result.elementCount).toBe(2);
    expect(result.occludedDropped).toBe(3);
  });
});
