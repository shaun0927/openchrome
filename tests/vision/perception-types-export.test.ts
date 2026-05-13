import type { PerceptionElement, PerceptionSnapshot } from '../../src/vision/perception-types';

describe('perception type export surface', () => {
  test('exports provider-neutral perception snapshot types', () => {
    const element: PerceptionElement = {
      id: 'v1',
      type: 'control',
      label: 'Continue',
      interactive: true,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      bboxRatio: { x: 0, y: 0, width: 0.1, height: 0.1 },
      source: 'mock',
    };
    const snapshot: PerceptionSnapshot = {
      version: 1,
      provider: 'mock',
      tabId: 'tab',
      url: 'https://example.test',
      capturedAt: 1,
      viewport: { width: 100, height: 100 },
      elements: [element],
      warnings: [],
      latencyMs: 1,
    };

    expect(snapshot.elements[0].id).toBe('v1');
  });
});
