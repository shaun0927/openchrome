/// <reference types="jest" />

import {
  buildPerceptionSnapshotFromAnnotatedResult,
  formatPerceptionSnapshotAsText,
  sanitizePerceptionLabel,
  validatePerceptionSnapshot,
  visionElementToPerceptionElement,
} from '../../src/vision/perception-provider';
import type { AnnotatedScreenshotResult, VisionElement } from '../../src/vision/types';

function annotated(elements: Record<number, VisionElement>, viewport = { width: 1000, height: 500 }): AnnotatedScreenshotResult {
  return {
    screenshot: 'base64-image',
    mimeType: 'image/webp',
    elementMap: elements,
    elementCount: Object.keys(elements).length,
    viewport,
    annotationTimeMs: 12,
  };
}

describe('perception snapshot helpers', () => {
  test('builds provider-neutral snapshot from annotated result', () => {
    const result = annotated({
      1: {
        number: 1,
        x: 100,
        y: 50,
        width: 200,
        height: 40,
        centerX: 200,
        centerY: 70,
        type: 'button',
        name: 'Continue',
        backendDOMNodeId: 42,
      },
    });

    const snapshot = buildPerceptionSnapshotFromAnnotatedResult(result, {
      provider: 'dom-annotator',
      tabId: 'tab-1',
      url: 'https://example.test',
      capturedAt: 123,
    });

    expect(snapshot).toMatchObject({
      version: 1,
      provider: 'dom-annotator',
      tabId: 'tab-1',
      url: 'https://example.test',
      capturedAt: 123,
      viewport: { width: 1000, height: 500 },
      screenshotMimeType: 'image/webp',
      latencyMs: 12,
      warnings: [],
    });
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]).toMatchObject({
      id: 'v1',
      type: 'control',
      label: 'Continue',
      role: 'button',
      interactive: true,
      source: 'dom-annotator',
      backendDOMNodeId: 42,
      bbox: { x: 100, y: 50, width: 200, height: 40 },
      bboxRatio: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 },
    });
  });

  test('clamps coordinates to viewport and normalizes ratios', () => {
    const element = visionElementToPerceptionElement({
      number: 2,
      x: -10,
      y: 25,
      width: 5000,
      height: 5000,
      centerX: 0,
      centerY: 0,
      type: 'link',
      name: 'Docs',
    }, { width: 300, height: 200 });

    expect(element.bbox).toEqual({ x: 0, y: 25, width: 300, height: 175 });
    expect(element.bboxRatio).toEqual({ x: 0, y: 0.125, width: 1, height: 0.875 });
  });

  test('bounds labels and redacts password-like fixture values', () => {
    expect(sanitizePerceptionLabel('password=super-secret-fixture-password')).toBe('[REDACTED]');
    expect(sanitizePerceptionLabel('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });

  test('truncates element list and emits warning', () => {
    const result = annotated({
      1: { number: 1, x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5, type: 'button', name: 'One' },
      2: { number: 2, x: 20, y: 0, width: 10, height: 10, centerX: 25, centerY: 5, type: 'button', name: 'Two' },
    });

    const snapshot = buildPerceptionSnapshotFromAnnotatedResult(result, {
      tabId: 'tab',
      url: 'https://example.test',
      maxElements: 1,
    });

    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.warnings.join('\n')).toContain('truncated from 2 to 1');
  });

  test('formats parseable snapshot JSON', () => {
    const snapshot = buildPerceptionSnapshotFromAnnotatedResult(annotated({}), {
      tabId: 'tab',
      url: 'https://example.test',
    });

    const parsed = JSON.parse(formatPerceptionSnapshotAsText(snapshot));
    expect(parsed).toEqual(snapshot);
  });
});


describe('perception snapshot schema validation', () => {
  test('accepts valid provider-neutral snapshots', () => {
    const snapshot = buildPerceptionSnapshotFromAnnotatedResult(annotated({
      1: { number: 1, x: 10, y: 10, width: 20, height: 20, centerX: 20, centerY: 20, type: 'button', name: 'OK' },
    }), { tabId: 'tab', url: 'https://example.test' });

    expect(validatePerceptionSnapshot(snapshot)).toEqual({ ok: true, errors: [], truncated: false });
  });

  test('rejects malformed provider output with bounded errors', () => {
    const result = validatePerceptionSnapshot({
      version: 1,
      provider: 'mock',
      tabId: 'tab',
      url: 'https://example.test',
      capturedAt: 1,
      viewport: { width: 100, height: 100 },
      warnings: [],
      latencyMs: 1,
      elements: [{
        id: '',
        type: 'bad',
        label: 123,
        interactive: 'maybe',
        source: '',
        bbox: { x: -1, y: 0, width: 10, height: 10 },
        bboxRatio: { x: 2, y: 0, width: 0.5, height: 0.5 },
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('elements[0].id');
    expect(result.errors.join('\n')).toContain('elements[0].type');
    expect(result.errors.join('\n')).toContain('bbox.x');
    expect(result.errors.join('\n')).toContain('bboxRatio.x');
  });

  test('rejects non-string element type even when string-coercible', () => {
    const result = validatePerceptionSnapshot({
      version: 1,
      provider: 'mock',
      tabId: 'tab',
      url: 'https://example.test',
      capturedAt: 1,
      viewport: { width: 100, height: 100 },
      warnings: [],
      latencyMs: 1,
      elements: [{
        id: 'v1',
        type: { toString: () => 'control' },
        label: 'OK',
        interactive: true,
        source: 'mock',
        bbox: { x: 0, y: 0, width: 10, height: 10 },
        bboxRatio: { x: 0, y: 0, width: 0.1, height: 0.1 },
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('elements[0].type');
  });

  test('limits validation diagnostics for hostile provider output', () => {
    const result = validatePerceptionSnapshot({
      version: 1,
      provider: 'mock',
      tabId: 'tab',
      url: 'https://example.test',
      capturedAt: 1,
      viewport: { width: 100, height: 100 },
      warnings: [],
      latencyMs: 1,
      elements: Array.from({ length: 100 }, () => ({
        id: '',
        type: 'bad',
        label: 123,
        interactive: 'maybe',
        source: '',
        bbox: { x: -1, y: -1, width: -1, height: -1 },
        bboxRatio: { x: 2, y: 2, width: 2, height: 2 },
      })),
    }, { maxErrors: 5, maxElements: 500 });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});
