import { PerceptualCache } from '../../../src/core/perception/cache';
import type { PerceptualMetadata, ViewportRect } from '../../../src/core/perception/types';

const VIEWPORT: ViewportRect = { x: 0, y: 0, w: 1280, h: 800 };

function md(extra: Partial<PerceptualMetadata> = {}): PerceptualMetadata {
  return {
    pixelBox: { x: 0, y: 0, w: 10, h: 10 },
    viewportVisible: true,
    effectiveOpacity: 1,
    effectiveDisplay: 'rendered',
    interactionFeasibility: 'ok',
    ...extra,
  };
}

describe('PerceptualCache — basic behavior', () => {
  test('miss invokes compute and stores the result', () => {
    const cache = new PerceptualCache();
    let calls = 0;
    const k = { frameId: 'f1', viewport: VIEWPORT, backendNodeId: 1 };
    const a = cache.getOrCompute(k, () => {
      calls++;
      return md();
    });
    const b = cache.getOrCompute(k, () => {
      calls++;
      return md({ effectiveOpacity: 0.5 });
    });
    expect(calls).toBe(1);
    expect(a).toBe(b); // identical reference (hit returns stored object)
  });

  test('different backendNodeId → independent entries', () => {
    const cache = new PerceptualCache();
    cache.getOrCompute({ frameId: 'f1', viewport: VIEWPORT, backendNodeId: 1 }, () => md({ effectiveOpacity: 1 }));
    cache.getOrCompute({ frameId: 'f1', viewport: VIEWPORT, backendNodeId: 2 }, () => md({ effectiveOpacity: 0.5 }));
    expect(cache.size()).toBe(2);
  });

  test('different viewport → independent entries', () => {
    const cache = new PerceptualCache();
    cache.getOrCompute({ frameId: 'f1', viewport: VIEWPORT, backendNodeId: 1 }, () => md());
    cache.getOrCompute({ frameId: 'f1', viewport: { x: 0, y: 0, w: 800, h: 600 }, backendNodeId: 1 }, () => md());
    expect(cache.size()).toBe(2);
  });
});

describe('PerceptualCache — invalidation', () => {
  test('bumpDoc(frameId) drops previous-counter entries for that frame', () => {
    const cache = new PerceptualCache();
    let calls = 0;
    const k = { frameId: 'f1', viewport: VIEWPORT, backendNodeId: 1 };
    cache.getOrCompute(k, () => {
      calls++;
      return md();
    });
    expect(calls).toBe(1);

    cache.bumpDoc('f1');
    cache.getOrCompute(k, () => {
      calls++;
      return md({ effectiveOpacity: 0.7 });
    });
    expect(calls).toBe(2);
    expect(cache.getDocCounter('f1')).toBe(1);
  });

  test('bumpDoc on one frame does not invalidate others', () => {
    const cache = new PerceptualCache();
    cache.getOrCompute({ frameId: 'f1', viewport: VIEWPORT, backendNodeId: 1 }, () => md());
    cache.getOrCompute({ frameId: 'f2', viewport: VIEWPORT, backendNodeId: 1 }, () => md());
    cache.bumpDoc('f1');
    // f1 was dropped, f2 retained
    expect(cache.size()).toBe(1);
    expect(cache.get({ frameId: 'f2', viewport: VIEWPORT, backendNodeId: 1 })).toBeDefined();
  });

  test('clear() drops everything', () => {
    const cache = new PerceptualCache();
    cache.getOrCompute({ frameId: 'f', viewport: VIEWPORT, backendNodeId: 1 }, () => md());
    cache.bumpDoc('f');
    cache.getOrCompute({ frameId: 'f', viewport: VIEWPORT, backendNodeId: 1 }, () => md());
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.getDocCounter('f')).toBe(0);
  });

  test('get() without compute returns undefined on miss', () => {
    const cache = new PerceptualCache();
    expect(cache.get({ frameId: 'f', viewport: VIEWPORT, backendNodeId: 1 })).toBeUndefined();
  });
});
