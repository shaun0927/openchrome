/// <reference types="jest" />
/**
 * Tests for AdaptiveScreenshot utility
 */

import { AdaptiveScreenshot } from '../../src/utils/adaptive-screenshot';

function createMockPage(scrollX = 0, scrollY = 0): any {
  return {
    evaluate: jest.fn().mockResolvedValue({ scrollTop: scrollY, scrollLeft: scrollX }),
  };
}

function createFailingPage(): any {
  return {
    evaluate: jest.fn().mockRejectedValue(new Error('Page closed')),
  };
}

describe('AdaptiveScreenshot', () => {
  beforeEach(() => {
    // Reset singleton between tests for isolation
    (AdaptiveScreenshot as any).instance = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --- Singleton ---

  describe('getInstance', () => {
    test('returns same instance on multiple calls', () => {
      const a = AdaptiveScreenshot.getInstance();
      const b = AdaptiveScreenshot.getInstance();
      expect(a).toBe(b);
    });
  });

  // --- Mode Degradation ---

  describe('mode degradation', () => {
    test('first screenshot at a position returns full', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('full');
    });

    test('second screenshot at same position within 30s returns annotated', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');
      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('annotated');
    });

    test('third screenshot at same position within 30s returns text_only', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');
      await instance.evaluate(page, 'tab-1');
      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('text_only');
    });

    test('fourth and beyond screenshot at same position returns text_only', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');
      await instance.evaluate(page, 'tab-1');
      await instance.evaluate(page, 'tab-1');
      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('text_only');
    });

    test('different scroll position resets degradation to full', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page1 = createMockPage(0, 0);
      const page2 = createMockPage(0, 500);

      await instance.evaluate(page1, 'tab-1');
      await instance.evaluate(page1, 'tab-1'); // annotated

      const mode = await instance.evaluate(page2, 'tab-1');

      expect(mode).toBe('full');
    });
  });

  // --- Position Tolerance ---

  describe('position tolerance', () => {
    test('scroll within 50px tolerance counts as same position → annotated', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page1 = createMockPage(0, 0);
      const page2 = createMockPage(30, 30);

      await instance.evaluate(page1, 'tab-1');
      const mode = await instance.evaluate(page2, 'tab-1');

      expect(mode).toBe('annotated');
    });

    test('scroll exactly 50px away counts as same position → annotated', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page1 = createMockPage(0, 0);
      const page2 = createMockPage(0, 50);

      await instance.evaluate(page1, 'tab-1');
      const mode = await instance.evaluate(page2, 'tab-1');

      expect(mode).toBe('annotated');
    });

    test('scroll beyond 50px tolerance counts as different position → full', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page1 = createMockPage(0, 0);
      const page2 = createMockPage(0, 100);

      await instance.evaluate(page1, 'tab-1');
      const mode = await instance.evaluate(page2, 'tab-1');

      expect(mode).toBe('full');
    });

    test('scroll 51px away counts as different position → full', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page1 = createMockPage(0, 0);
      const page2 = createMockPage(0, 51);

      await instance.evaluate(page1, 'tab-1');
      const mode = await instance.evaluate(page2, 'tab-1');

      expect(mode).toBe('full');
    });
  });

  // --- Time Window ---

  describe('time window', () => {
    test('repeat outside 30s window resets to full', async () => {
      jest.useFakeTimers();

      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');

      // Advance time beyond the 30s repeat window
      jest.advanceTimersByTime(31_000);

      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('full');
    });

    test('repeat exactly at 30s boundary still counts as same window → annotated', async () => {
      jest.useFakeTimers();

      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');

      // Advance to exactly 30s — still within window (<=)
      jest.advanceTimersByTime(30_000);

      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('annotated');
    });

    test('entries are pruned after 60s', async () => {
      jest.useFakeTimers();

      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      // Build up history
      await instance.evaluate(page, 'tab-1');
      await instance.evaluate(page, 'tab-1');
      // At this point next call would return text_only

      // Advance past the 60s prune age
      jest.advanceTimersByTime(61_000);

      // Old records pruned; new call is treated as first
      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('full');
    });
  });

  // --- Reset ---

  describe('reset', () => {
    test('reset clears history for the tab', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');
      await instance.evaluate(page, 'tab-1'); // annotated

      instance.reset('tab-1');

      const mode = await instance.evaluate(page, 'tab-1');
      expect(mode).toBe('full');
    });

    test('reset on one tab does not affect another tab', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-1');
      await instance.evaluate(page, 'tab-2');

      instance.reset('tab-1');

      // tab-2 still has its first record, so second call → annotated
      const mode = await instance.evaluate(page, 'tab-2');
      expect(mode).toBe('annotated');
    });
  });

  // --- Quality Mapping ---

  describe('getQualityForMode', () => {
    test('full mode returns normal quality', () => {
      const instance = AdaptiveScreenshot.getInstance();
      expect(instance.getQualityForMode('full')).toBe('normal');
    });

    test('annotated mode returns low quality', () => {
      const instance = AdaptiveScreenshot.getInstance();
      expect(instance.getQualityForMode('annotated')).toBe('low');
    });

    test('text_only mode returns low quality', () => {
      const instance = AdaptiveScreenshot.getInstance();
      expect(instance.getQualityForMode('text_only')).toBe('low');
    });
  });

  // --- Annotation ---

  describe('getAnnotation', () => {
    test('returns expected annotation string', () => {
      const instance = AdaptiveScreenshot.getInstance();
      expect(instance.getAnnotation()).toBe(
        'Note: No significant visual change detected since last screenshot at this scroll position.',
      );
    });
  });

  // --- Error Handling ---

  describe('error handling', () => {
    test('page.evaluate failure returns full gracefully', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createFailingPage();

      const mode = await instance.evaluate(page, 'tab-1');

      expect(mode).toBe('full');
    });

    test('page.evaluate failure does not record history entry', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const failPage = createFailingPage();
      const goodPage = createMockPage(0, 0);

      // This should fail silently
      await instance.evaluate(failPage, 'tab-1');

      // Since nothing was recorded, first real call should still be full
      const mode = await instance.evaluate(goodPage, 'tab-1');
      expect(mode).toBe('full');
    });
  });

  // --- Multi-tab Isolation ---

  describe('multi-tab isolation', () => {
    test('different tabs have independent history', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      // Tab A: advance to text_only
      await instance.evaluate(page, 'tab-A');
      await instance.evaluate(page, 'tab-A');
      const modeA = await instance.evaluate(page, 'tab-A');

      // Tab B: first screenshot
      const modeB = await instance.evaluate(page, 'tab-B');

      expect(modeA).toBe('text_only');
      expect(modeB).toBe('full');
    });

    test('multiple tabs accumulate history independently', async () => {
      const instance = AdaptiveScreenshot.getInstance();
      const page = createMockPage(0, 0);

      await instance.evaluate(page, 'tab-X');
      const modeX = await instance.evaluate(page, 'tab-X'); // annotated

      await instance.evaluate(page, 'tab-Y');
      await instance.evaluate(page, 'tab-Y');
      const modeY = await instance.evaluate(page, 'tab-Y'); // text_only

      expect(modeX).toBe('annotated');
      expect(modeY).toBe('text_only');
    });
  });
});
