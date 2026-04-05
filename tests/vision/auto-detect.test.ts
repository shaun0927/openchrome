/// <reference types="jest" />
/**
 * Tests for Vision Auto-Detection (Phase 3: Intelligent Mode Selection #577)
 */

import {
  detectVisionHints,
  checkRepeatedFailures,
  formatVisionHints,
} from '../../src/vision/auto-detect';
import type { VisionHint } from '../../src/vision/types';

// ─── Mock Page Factory ───

function createMockPage(evaluateResult: unknown) {
  return {
    evaluate: jest.fn().mockResolvedValue(evaluateResult),
  };
}

// ─── detectVisionHints ───

describe('detectVisionHints', () => {
  it('returns canvas hint with high confidence for pages with large canvas', async () => {
    const page = createMockPage({
      hasLargeCanvas: true,
      canvasCount: 1,
      crossOriginIframeCount: 0,
      interactiveCount: 10,
      totalElements: 50,
    });

    const hints = await detectVisionHints(page as any);

    expect(hints).toHaveLength(1);
    expect(hints[0].source).toBe('canvas');
    expect(hints[0].confidence).toBe('high');
    expect(hints[0].reason).toContain('canvas element(s)');
  });

  it('returns iframe hint for pages with cross-origin iframes', async () => {
    const page = createMockPage({
      hasLargeCanvas: false,
      canvasCount: 0,
      crossOriginIframeCount: 2,
      interactiveCount: 10,
      totalElements: 50,
    });

    const hints = await detectVisionHints(page as any);

    expect(hints).toHaveLength(1);
    expect(hints[0].source).toBe('iframe');
    expect(hints[0].confidence).toBe('medium');
    expect(hints[0].reason).toContain('cross-origin iframe(s)');
  });

  it('returns sparse-ax hint for pages with many elements but few interactive', async () => {
    const page = createMockPage({
      hasLargeCanvas: false,
      canvasCount: 0,
      crossOriginIframeCount: 0,
      interactiveCount: 2,
      totalElements: 500,
    });

    const hints = await detectVisionHints(page as any);

    expect(hints).toHaveLength(1);
    expect(hints[0].source).toBe('sparse-ax');
    expect(hints[0].confidence).toBe('medium');
    expect(hints[0].reason).toContain('500 elements but only 2 interactive');
  });

  it('returns empty array for normal page with no vision triggers', async () => {
    const page = createMockPage({
      hasLargeCanvas: false,
      canvasCount: 0,
      crossOriginIframeCount: 0,
      interactiveCount: 20,
      totalElements: 150,
    });

    const hints = await detectVisionHints(page as any);

    expect(hints).toHaveLength(0);
  });

  it('returns empty array when page.evaluate fails', async () => {
    const page = {
      evaluate: jest.fn().mockRejectedValue(new Error('Page crashed')),
    };

    const hints = await detectVisionHints(page as any);

    expect(hints).toHaveLength(0);
  });

  it('sorts hints by confidence (high first)', async () => {
    const page = createMockPage({
      hasLargeCanvas: true,
      canvasCount: 2,
      crossOriginIframeCount: 1,
      interactiveCount: 3,
      totalElements: 200,
    });

    const hints = await detectVisionHints(page as any);

    // Should have canvas (high), iframe (medium), sparse-ax (medium)
    expect(hints.length).toBe(3);
    expect(hints[0].confidence).toBe('high');
    expect(hints[0].source).toBe('canvas');
    // Medium confidence hints follow
    expect(hints[1].confidence).toBe('medium');
    expect(hints[2].confidence).toBe('medium');
  });
});

// ─── checkRepeatedFailures ───

describe('checkRepeatedFailures', () => {
  it('returns hint when failures >= 3', () => {
    const checkFn = jest.fn().mockReturnValue({ state: 'HALF-OPEN', failures: 5 });

    const hint = checkRepeatedFailures('tab-1', checkFn);

    expect(hint).not.toBeNull();
    expect(hint!.source).toBe('repeated-failure');
    expect(hint!.reason).toContain('5 DOM-based failures');
    expect(checkFn).toHaveBeenCalledWith('tab-1');
  });

  it('returns high confidence when circuit breaker state is OPEN', () => {
    const checkFn = jest.fn().mockReturnValue({ state: 'OPEN', failures: 3 });

    const hint = checkRepeatedFailures('tab-1', checkFn);

    expect(hint).not.toBeNull();
    expect(hint!.confidence).toBe('high');
  });

  it('returns medium confidence when circuit breaker state is not OPEN', () => {
    const checkFn = jest.fn().mockReturnValue({ state: 'HALF-OPEN', failures: 4 });

    const hint = checkRepeatedFailures('tab-1', checkFn);

    expect(hint).not.toBeNull();
    expect(hint!.confidence).toBe('medium');
  });

  it('returns null when failures < 3', () => {
    const checkFn = jest.fn().mockReturnValue({ state: 'CLOSED', failures: 2 });

    const hint = checkRepeatedFailures('tab-1', checkFn);

    expect(hint).toBeNull();
  });

  it('returns null when failures is 0', () => {
    const checkFn = jest.fn().mockReturnValue({ state: 'CLOSED', failures: 0 });

    const hint = checkRepeatedFailures('tab-2', checkFn);

    expect(hint).toBeNull();
  });
});

// ─── formatVisionHints ───

describe('formatVisionHints', () => {
  it('formats hints as user-friendly string', () => {
    const hints: VisionHint[] = [
      { reason: 'Canvas detected', confidence: 'high', source: 'canvas' },
      { reason: 'Cross-origin iframes', confidence: 'medium', source: 'iframe' },
    ];

    const result = formatVisionHints(hints);

    expect(result).toContain('Vision mode suggested:');
    expect(result).toContain('[high] Canvas detected');
    expect(result).toContain('[medium] Cross-origin iframes');
  });

  it('returns empty string for empty hints array', () => {
    expect(formatVisionHints([])).toBe('');
  });
});
