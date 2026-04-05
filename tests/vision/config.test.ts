/// <reference types="jest" />
/**
 * Tests for Vision Config — cost tracking helpers (Phase 3: #577)
 */

describe('vision config cost tracking', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('trackVisionUsage increments call count and total time', async () => {
    const { trackVisionUsage, getVisionStats } = await import('../../src/vision/config');

    trackVisionUsage(150);
    trackVisionUsage(250);

    const stats = getVisionStats();
    expect(stats.calls).toBe(2);
    expect(stats.totalTimeMs).toBe(400);
  });

  it('getVisionStats returns zeroes initially', async () => {
    const { getVisionStats } = await import('../../src/vision/config');

    const stats = getVisionStats();
    expect(stats.calls).toBe(0);
    expect(stats.totalTimeMs).toBe(0);
  });

  it('resetVisionStats clears all counters', async () => {
    const { trackVisionUsage, getVisionStats, resetVisionStats } = await import('../../src/vision/config');

    trackVisionUsage(100);
    trackVisionUsage(200);
    resetVisionStats();

    const stats = getVisionStats();
    expect(stats.calls).toBe(0);
    expect(stats.totalTimeMs).toBe(0);
  });
});

describe('getVisionMode (additional coverage)', () => {
  const originalEnv = process.env.OPENCHROME_VISION_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCHROME_VISION_MODE;
    } else {
      process.env.OPENCHROME_VISION_MODE = originalEnv;
    }
    jest.resetModules();
  });

  it('returns fallback when env is set to "fallback"', async () => {
    process.env.OPENCHROME_VISION_MODE = 'fallback';
    const { getVisionMode } = await import('../../src/vision/config');
    expect(getVisionMode()).toBe('fallback');
  });

  it('returns fallback when env is empty string', async () => {
    process.env.OPENCHROME_VISION_MODE = '';
    const { getVisionMode } = await import('../../src/vision/config');
    expect(getVisionMode()).toBe('fallback');
  });
});
