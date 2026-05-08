import {
  computePerceptualMetadata,
  effectiveOpacity,
  intersects,
} from '../../src/perception/metadata';
import type { NodeProbe, ViewportRect } from '../../src/perception/types';

const VIEWPORT: ViewportRect = { x: 0, y: 0, w: 1280, h: 800 };

function probe(over: Partial<NodeProbe> = {}): NodeProbe {
  return {
    backendNodeId: 42,
    display: 'block',
    visibility: 'visible',
    opacityChain: [],
    pixelBox: { x: 100, y: 100, w: 200, h: 50 },
    topElementBackendNodeId: 42,
    hasChildBoxes: false,
    ancestorDisplayNone: false,
    ancestorVisibilityHidden: false,
    ...over,
  };
}

describe('effectiveOpacity', () => {
  test('empty chain → 1', () => {
    expect(effectiveOpacity([])).toBe(1);
  });

  test('multiplies values', () => {
    expect(effectiveOpacity([1, 0.5, 0.5])).toBeCloseTo(0.25);
  });

  test('clamps out-of-range to [0,1]', () => {
    expect(effectiveOpacity([1.5, 1])).toBe(1);
    expect(effectiveOpacity([-1, 1])).toBe(0);
  });

  test('NaN treated as 1 (defensive)', () => {
    expect(effectiveOpacity([Number.NaN, 0.5])).toBe(0.5);
  });
});

describe('intersects', () => {
  test('overlapping rectangles → true', () => {
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  test('edge-touching rectangles → false (strict overlap)', () => {
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });

  test('zero-size → false', () => {
    expect(intersects({ x: 0, y: 0, w: 0, h: 10 }, VIEWPORT)).toBe(false);
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 10 })).toBe(false);
  });
});

describe('computePerceptualMetadata — effectiveDisplay enum', () => {
  test('plain visible block → rendered + ok', () => {
    const r = computePerceptualMetadata(probe(), VIEWPORT);
    expect(r.effectiveDisplay).toBe('rendered');
    expect(r.interactionFeasibility).toBe('ok');
    expect(r.viewportVisible).toBe(true);
  });

  test('display:none on the node → hidden_display_none', () => {
    const r = computePerceptualMetadata(probe({ display: 'none' }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('hidden_display_none');
  });

  test('ancestor display:none → hidden_display_none', () => {
    const r = computePerceptualMetadata(probe({ ancestorDisplayNone: true }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('hidden_display_none');
  });

  test('visibility:hidden → hidden_visibility', () => {
    const r = computePerceptualMetadata(probe({ visibility: 'hidden' }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('hidden_visibility');
  });

  test('visibility:collapse → hidden_visibility', () => {
    const r = computePerceptualMetadata(probe({ visibility: 'collapse' }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('hidden_visibility');
  });

  test('display:contents WITH child boxes → rendered (#709 v2 fix)', () => {
    const r = computePerceptualMetadata(probe({ display: 'contents', hasChildBoxes: true }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('rendered');
  });

  test('display:contents WITHOUT child boxes → display_contents_no_box (#709 v2 fix)', () => {
    const r = computePerceptualMetadata(
      probe({ display: 'contents', hasChildBoxes: false, pixelBox: null }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('display_contents_no_box');
    expect(r.interactionFeasibility).toBe('outside_viewport');
  });

  test('off_screen — viewport intersection fails', () => {
    const r = computePerceptualMetadata(
      probe({ pixelBox: { x: -500, y: -500, w: 100, h: 100 } }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('off_screen');
    expect(r.interactionFeasibility).toBe('outside_viewport');
  });

  test('covered_by — different topElementBackendNodeId at center', () => {
    const r = computePerceptualMetadata(probe({ topElementBackendNodeId: 999 }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('covered_by');
    expect(r.coveredByNodeId).toBe(999);
    expect(r.interactionFeasibility).toBe('blocked_by_overlay');
  });

  test('off_screen takes priority over covered_by', () => {
    const r = computePerceptualMetadata(
      probe({
        pixelBox: { x: -500, y: -500, w: 100, h: 100 },
        topElementBackendNodeId: 999,
      }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('off_screen');
    expect(r.coveredByNodeId).toBeUndefined();
  });

  test('null topElementBackendNodeId → conservatively reports rendered (host did not query)', () => {
    const r = computePerceptualMetadata(probe({ topElementBackendNodeId: null }), VIEWPORT);
    expect(r.effectiveDisplay).toBe('rendered');
    expect(r.interactionFeasibility).toBe('ok');
  });
});

describe('computePerceptualMetadata — interactionFeasibility', () => {
  test('zero-size box → zero_size', () => {
    const r = computePerceptualMetadata(
      probe({ pixelBox: { x: 0, y: 0, w: 0, h: 10 } }),
      VIEWPORT,
    );
    expect(r.interactionFeasibility).toBe('zero_size');
  });

  test('null pixelBox → zero_size', () => {
    const r = computePerceptualMetadata(probe({ pixelBox: null }), VIEWPORT);
    expect(r.interactionFeasibility).toBe('zero_size');
  });

  test('outside viewport → outside_viewport (no overlay needed)', () => {
    const r = computePerceptualMetadata(
      probe({ pixelBox: { x: 5000, y: 5000, w: 100, h: 100 } }),
      VIEWPORT,
    );
    expect(r.interactionFeasibility).toBe('outside_viewport');
  });

  test('hidden by ancestor → outside_viewport (cannot interact)', () => {
    const r = computePerceptualMetadata(probe({ ancestorVisibilityHidden: true }), VIEWPORT);
    expect(r.interactionFeasibility).toBe('outside_viewport');
  });
});

describe('computePerceptualMetadata — pointer-events regression (P1)', () => {
  test('pointer-events:none → pointer_events_none, not ok', () => {
    const r = computePerceptualMetadata(probe({ pointerEvents: 'none' }), VIEWPORT);
    expect(r.interactionFeasibility).toBe('pointer_events_none');
    expect(r.effectiveDisplay).toBe('rendered');
  });

  test('pointer-events:none with foreign topElement → NOT covered_by (round-2 fix)', () => {
    // elementFromPoint returns a different node when pointer-events:none —
    // that is expected behavior, not an overlay. Must not set covered_by.
    const r = computePerceptualMetadata(
      probe({ pointerEvents: 'none', topElementBackendNodeId: 999 }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('rendered');
    expect(r.coveredByNodeId).toBeUndefined();
    expect(r.interactionFeasibility).toBe('pointer_events_none');
  });

  test('pointer-events:auto (default) → ok', () => {
    const r = computePerceptualMetadata(probe({ pointerEvents: 'auto' }), VIEWPORT);
    expect(r.interactionFeasibility).toBe('ok');
  });

  test('pointer-events field absent → ok (backward compat)', () => {
    const r = computePerceptualMetadata(probe(), VIEWPORT);
    expect(r.interactionFeasibility).toBe('ok');
  });

  test('pointer-events:none off-screen → outside_viewport (off-screen takes priority)', () => {
    const r = computePerceptualMetadata(
      probe({ pixelBox: { x: -500, y: -500, w: 100, h: 100 }, pointerEvents: 'none' }),
      VIEWPORT,
    );
    expect(r.interactionFeasibility).toBe('outside_viewport');
  });
});

describe('computePerceptualMetadata — descendant hit regression (P2)', () => {
  test('button containing span — hit on span → NOT covered_by', () => {
    const spanId = 99;
    const r = computePerceptualMetadata(
      probe({
        backendNodeId: 42,
        topElementBackendNodeId: spanId,
        descendantBackendNodeIds: new Set([spanId]),
      }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('rendered');
    expect(r.coveredByNodeId).toBeUndefined();
    expect(r.interactionFeasibility).toBe('ok');
  });

  test('truly foreign overlay → still covered_by', () => {
    const r = computePerceptualMetadata(
      probe({
        backendNodeId: 42,
        topElementBackendNodeId: 999,
        descendantBackendNodeIds: new Set([10, 11]),
      }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('covered_by');
    expect(r.coveredByNodeId).toBe(999);
    expect(r.interactionFeasibility).toBe('blocked_by_overlay');
  });

  test('no descendantBackendNodeIds provided — foreign hit still flagged as overlay', () => {
    const r = computePerceptualMetadata(
      probe({ backendNodeId: 42, topElementBackendNodeId: 999 }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('covered_by');
    expect(r.coveredByNodeId).toBe(999);
  });
});

describe('computePerceptualMetadata — display:contents feasibility (P2 fix)', () => {
  test('display:contents + hasChildBoxes=true + null pixelBox → interactionFeasibility is NOT zero_size', () => {
    const r = computePerceptualMetadata(
      probe({ display: 'contents', hasChildBoxes: true, pixelBox: null, topElementBackendNodeId: 42 }),
      VIEWPORT,
    );
    expect(r.interactionFeasibility).not.toBe('zero_size');
  });

  test('display:contents + hasChildBoxes=true + null pixelBox → feasibility is ok (node is on top)', () => {
    const r = computePerceptualMetadata(
      probe({ display: 'contents', hasChildBoxes: true, pixelBox: null, topElementBackendNodeId: 42 }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('rendered');
    expect(r.interactionFeasibility).toBe('ok');
  });

  test('display:contents + hasChildBoxes=false + null pixelBox → outside_viewport (no child boxes)', () => {
    const r = computePerceptualMetadata(
      probe({ display: 'contents', hasChildBoxes: false, pixelBox: null }),
      VIEWPORT,
    );
    expect(r.effectiveDisplay).toBe('display_contents_no_box');
    expect(r.interactionFeasibility).toBe('outside_viewport');
  });

  test('non-contents node + null pixelBox → still zero_size (guard is scoped to display:contents)', () => {
    const r = computePerceptualMetadata(probe({ pixelBox: null }), VIEWPORT);
    expect(r.interactionFeasibility).toBe('zero_size');
  });

  test('display:contents + hasChildBoxes=true + null pixelBox → viewportVisible true AND feasibility ok (round-8 P2)', () => {
    const r = computePerceptualMetadata(
      probe({ display: 'contents', hasChildBoxes: true, pixelBox: null, topElementBackendNodeId: 42 }),
      VIEWPORT,
    );
    expect(r.viewportVisible).toBe(true);
    expect(r.interactionFeasibility).toBe('ok');
  });

  test('non-contents null pixelBox → viewportVisible remains false (guard does not apply)', () => {
    const r = computePerceptualMetadata(probe({ pixelBox: null }), VIEWPORT);
    expect(r.viewportVisible).toBe(false);
  });
});

describe('computePerceptualMetadata — opacity propagation', () => {
  test('opacity surfaces to effectiveOpacity', () => {
    const r = computePerceptualMetadata(probe({ opacityChain: [1, 0.4] }), VIEWPORT);
    expect(r.effectiveOpacity).toBeCloseTo(0.4);
  });

  test('zero ancestor opacity → effectiveOpacity 0 but rendering classification unaffected', () => {
    // (Per #709 v2 we report the metadata raw; the cross-check / hint
    // engine in #710 decides whether opacity-zero is "honeypot" or
    // intentional UI.)
    const r = computePerceptualMetadata(probe({ opacityChain: [0] }), VIEWPORT);
    expect(r.effectiveOpacity).toBe(0);
    expect(r.effectiveDisplay).toBe('rendered');
  });
});
