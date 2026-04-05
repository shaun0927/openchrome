/// <reference types="jest" />
/**
 * Tests for Screenshot Analyzer (Phase 1: Vision Hybrid Mode #577)
 */

import {
  collectInteractiveElements,
  buildElementMap,
  formatElementMapAsText,
  analyzeScreenshot,
  RawElement,
} from '../../src/vision/screenshot-analyzer';
import type { VisionElementMap } from '../../src/vision/types';

// ─── Mock Page Factory ───

function createMockPage(evaluateResult: unknown[] = [], viewport = { width: 1920, height: 1080 }) {
  return {
    evaluate: jest.fn().mockImplementation((_fn: Function, ...args: unknown[]) => {
      if (args.length === 3 && typeof args[2] === 'string' && String(args[2]).includes('oc_vision')) {
        return Promise.resolve();
      }
      if (args.length === 1 && typeof args[0] === 'string' && String(args[0]).includes('oc_vision')) {
        return Promise.resolve();
      }
      return Promise.resolve(evaluateResult);
    }),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
    viewport: jest.fn().mockReturnValue(viewport),
  };
}

// ─── collectInteractiveElements ───

describe('collectInteractiveElements', () => {
  it('returns elements sorted in reading order', async () => {
    const mockElements = [
      { role: 'button', name: 'Submit', x: 200, y: 100, width: 80, height: 30 },
      { role: 'link', name: 'Home', x: 10, y: 10, width: 60, height: 20 },
      { role: 'textbox', name: 'Email', x: 10, y: 100, width: 200, height: 30 },
    ];
    const page = createMockPage(mockElements);
    const result = await collectInteractiveElements(page as any, true);

    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('Home');
    expect(result[1].name).toBe('Email');
    expect(result[2].name).toBe('Submit');
  });

  it('passes interactiveOnly flag to page.evaluate', async () => {
    const page = createMockPage([]);
    await collectInteractiveElements(page as any, true);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), true);

    await collectInteractiveElements(page as any, false);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), false);
  });

  it('handles empty page', async () => {
    const page = createMockPage([]);
    const result = await collectInteractiveElements(page as any, true);
    expect(result).toHaveLength(0);
  });

  it('propagates page.evaluate errors', async () => {
    const page = createMockPage([]);
    page.evaluate.mockRejectedValueOnce(new Error('Page crashed'));
    await expect(collectInteractiveElements(page as any, true)).rejects.toThrow('Page crashed');
  });
});

// ─── buildElementMap ───

describe('buildElementMap', () => {
  const elements: RawElement[] = [
    { role: 'button', name: 'OK', x: 100, y: 200, width: 80, height: 30 },
    { role: 'link', name: 'Help', x: 300, y: 50, width: 40, height: 20, backendDOMNodeId: 42 },
  ];

  it('assigns sequential numbers starting from 1', () => {
    const map = buildElementMap(elements);
    expect(map[1].number).toBe(1);
    expect(map[2].number).toBe(2);
  });

  it('calculates center coordinates', () => {
    const map = buildElementMap(elements);
    expect(map[1].centerX).toBe(140);
    expect(map[1].centerY).toBe(215);
    expect(map[2].centerX).toBe(320);
    expect(map[2].centerY).toBe(60);
  });

  it('preserves type, name, and dimensions', () => {
    const map = buildElementMap(elements);
    expect(map[1].type).toBe('button');
    expect(map[1].name).toBe('OK');
    expect(map[2].type).toBe('link');
    expect(map[2].name).toBe('Help');
  });

  it('preserves backendDOMNodeId when present', () => {
    const map = buildElementMap(elements);
    expect(map[1].backendDOMNodeId).toBeUndefined();
    expect(map[2].backendDOMNodeId).toBe(42);
  });

  it('handles empty array', () => {
    expect(Object.keys(buildElementMap([]))).toHaveLength(0);
  });

  it('handles large element list (500 elements)', () => {
    const large: RawElement[] = Array.from({ length: 500 }, (_, i) => ({
      role: 'button', name: `Btn ${i}`,
      x: i * 10, y: Math.floor(i / 10) * 30, width: 80, height: 25,
    }));
    const map = buildElementMap(large);
    expect(Object.keys(map)).toHaveLength(500);
    expect(map[1].number).toBe(1);
    expect(map[500].number).toBe(500);
  });
});

// ─── formatElementMapAsText ───

describe('formatElementMapAsText', () => {
  it('formats elements as readable text', () => {
    const map: VisionElementMap = {
      1: { number: 1, x: 10, y: 20, width: 100, height: 30, centerX: 60, centerY: 35, type: 'button', name: 'Submit' },
      2: { number: 2, x: 200, y: 50, width: 80, height: 25, centerX: 240, centerY: 63, type: 'link', name: 'Cancel' },
    };
    const text = formatElementMapAsText(map);
    expect(text).toContain('2 interactive elements:');
    expect(text).toContain('[1] button: "Submit" at (60, 35) 100x30');
    expect(text).toContain('[2] link: "Cancel" at (240, 63) 80x25');
  });

  it('returns message for empty map', () => {
    expect(formatElementMapAsText({})).toBe('No interactive elements found.');
  });
});

// ─── analyzeScreenshot ───

describe('analyzeScreenshot', () => {
  it('returns complete result with screenshot, map, and metadata', async () => {
    const mockElements = [
      { role: 'button', name: 'Click Me', x: 50, y: 60, width: 100, height: 35 },
    ];
    const page = createMockPage(mockElements);
    const result = await analyzeScreenshot(page as any, { format: 'webp', quality: 60 });

    expect(result.screenshot).toBeTruthy();
    expect(result.mimeType).toBe('image/webp');
    expect(result.elementCount).toBe(1);
    expect(result.elementMap[1].type).toBe('button');
    expect(result.elementMap[1].name).toBe('Click Me');
    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
    expect(result.annotationTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('cleans up overlay after screenshot capture', async () => {
    const page = createMockPage([{ role: 'button', name: 'A', x: 0, y: 0, width: 50, height: 20 }]);
    await analyzeScreenshot(page as any);
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('cleans up overlay even if screenshot fails', async () => {
    const page = createMockPage([{ role: 'button', name: 'A', x: 0, y: 0, width: 50, height: 20 }]);
    page.screenshot.mockRejectedValueOnce(new Error('Screenshot failed'));
    await expect(analyzeScreenshot(page as any)).rejects.toThrow('Screenshot failed');
    expect(page.evaluate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('uses default options when none provided', async () => {
    const page = createMockPage([]);
    const result = await analyzeScreenshot(page as any);
    expect(result.mimeType).toBe('image/webp');
    expect(result.elementCount).toBe(0);
  });

  it('respects png format option', async () => {
    const page = createMockPage([]);
    const result = await analyzeScreenshot(page as any, { format: 'png' });
    expect(result.mimeType).toBe('image/png');
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }));
  });

  it('falls back to default viewport when page.viewport() returns null', async () => {
    const page = createMockPage([]);
    page.viewport.mockReturnValue(null);
    const result = await analyzeScreenshot(page as any);
    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
  });
});
