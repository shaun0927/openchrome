/// <reference types="jest" />

import {
  DOM_PERCEPTION_MAX_AGE_MS,
  VISUAL_PERCEPTION_MAX_AGE_MS,
  resolvePerceptionTarget,
} from '../../src/vision/perception-target';
import type { PerceptionSnapshot } from '../../src/vision/types';

const NOW = 10_000_000;
const VIEWPORT = { width: 1280, height: 720 };

function snapshot(overrides: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot {
  return {
    version: 1,
    provider: 'mock',
    tabId: 'tab-1',
    url: 'https://example.test/app',
    capturedAt: NOW - 100,
    viewport: VIEWPORT,
    elements: [{
      id: 'v1',
      type: 'control',
      label: 'Continue',
      role: 'button',
      interactive: true,
      bbox: { x: 100, y: 200, width: 80, height: 40 },
      bboxRatio: { x: 100 / 1280, y: 200 / 720, width: 80 / 1280, height: 40 / 720 },
      source: 'mock',
      backendDOMNodeId: 42,
    }],
    warnings: [],
    latencyMs: 10,
    ...overrides,
  };
}

function resolve(candidate: unknown, elementId: unknown = 'v1') {
  return resolvePerceptionTarget({
    snapshot: candidate,
    elementId,
    tabId: 'tab-1',
    url: 'https://example.test/app',
    viewport: VIEWPORT,
    now: NOW,
  });
}

describe('resolvePerceptionTarget', () => {
  test('accepts a DOM-backed target and marks it for live backend-node resolution', () => {
    const result = resolve(snapshot());

    expect(result).toMatchObject({
      ok: true,
      target: {
        resolution: 'backend-node',
        snapshotAgeMs: 100,
        point: { x: 140, y: 220 },
        element: { id: 'v1', backendDOMNodeId: 42 },
      },
    });
  });

  test('accepts a fresh visual-only target when viewport and provenance still match', () => {
    const candidate = snapshot({
      elements: [{
        id: 'v2',
        type: 'control',
        label: 'Open map marker',
        interactive: true,
        bbox: { x: 20, y: 40, width: 30, height: 20 },
        bboxRatio: { x: 20 / 1280, y: 40 / 720, width: 30 / 1280, height: 20 / 720 },
        source: 'mock',
      }],
    });

    const result = resolve(candidate, 'v2');

    expect(result).toMatchObject({
      ok: true,
      target: { resolution: 'snapshot-bbox', point: { x: 35, y: 50 } },
    });
  });

  test('rejects tiled document-space snapshots before browser input', () => {
    const result = resolve(snapshot({ captureMode: 'tiled' }));

    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_PERCEPTION_TARGET',
      reason: 'unsupported_capture_mode',
    });
  });

  test.each([
    ['tab mismatch', snapshot({ tabId: 'tab-2' }), 'tab_mismatch'],
    ['URL mismatch', snapshot({ url: 'https://example.test/other' }), 'url_mismatch'],
    ['missing element', snapshot(), 'element_not_found', 'missing'],
    ['non-interactive element', snapshot({ elements: [{ ...snapshot().elements[0], interactive: false }] }), 'element_not_interactive'],
    ['invalid backend id', snapshot({ elements: [{ ...snapshot().elements[0], backendDOMNodeId: -1 }] }), 'invalid_backend_node_id'],
    ['out-of-bounds box', snapshot({ elements: [{ ...snapshot().elements[0], bbox: { x: 1260, y: 10, width: 40, height: 20 } }] }), 'invalid_bbox'],
  ])('rejects %s before browser input', (_name, candidate, reason, elementId = 'v1') => {
    const result = resolve(candidate, elementId);

    expect(result).toMatchObject({ ok: false, reason });
  });

  test('rejects duplicate element IDs', () => {
    const element = snapshot().elements[0];
    const result = resolve(snapshot({ elements: [element, { ...element }] }));

    expect(result).toMatchObject({ ok: false, reason: 'duplicate_element_id' });
  });

  test('rejects stale DOM-backed and visual-only targets using separate bounds', () => {
    const staleDom = resolve(snapshot({ capturedAt: NOW - DOM_PERCEPTION_MAX_AGE_MS - 1 }));
    const visualElement = { ...snapshot().elements[0] };
    delete visualElement.backendDOMNodeId;
    const staleVisual = resolve(snapshot({
      capturedAt: NOW - VISUAL_PERCEPTION_MAX_AGE_MS - 1,
      elements: [visualElement],
    }));

    expect(staleDom).toMatchObject({ ok: false, code: 'STALE_PERCEPTION_TARGET', reason: 'snapshot_stale' });
    expect(staleVisual).toMatchObject({ ok: false, code: 'STALE_PERCEPTION_TARGET', reason: 'snapshot_stale' });
  });

  test('rejects visual-only viewport drift and unsafe labels', () => {
    const visualElement = { ...snapshot().elements[0], label: 'Pay now' };
    delete visualElement.backendDOMNodeId;
    const unsafe = resolve(snapshot({ elements: [visualElement] }));
    const drifted = resolvePerceptionTarget({
      snapshot: snapshot({ elements: [{ ...visualElement, label: 'Open menu' }] }),
      elementId: 'v1',
      tabId: 'tab-1',
      url: 'https://example.test/app',
      viewport: { width: 800, height: 600 },
      now: NOW,
    });

    expect(unsafe).toMatchObject({ ok: false, reason: 'unsafe_visual_label' });
    expect(drifted).toMatchObject({ ok: false, code: 'STALE_PERCEPTION_TARGET', reason: 'viewport_mismatch' });
  });

  test('bounds malformed provider diagnostics', () => {
    const result = resolve({ version: 1, elements: Array.from({ length: 1000 }, () => ({})) });

    expect(result).toMatchObject({ ok: false, reason: 'malformed_snapshot' });
    if (result.ok) throw new Error('expected failure');
    expect((result.details?.errors as string[]).length).toBeLessThanOrEqual(10);
  });
});
