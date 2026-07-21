/**
 * Pixel-grounding fallback tier contract tests.
 */

import {
  PixelGroundingFallbackChain,
  coordinatesInViewport,
  validateGroundingRequest,
  type PixelGroundingAdapter,
  type PixelGroundingRequest,
  type PixelGroundingResult,
} from '../../src/vision/pixel-grounding-fallback';

function mkRequest(over: Partial<PixelGroundingRequest> = {}): PixelGroundingRequest {
  return {
    action: 'click',
    target: 'the blue Submit button',
    viewport: { width: 1280, height: 800 },
    screenshot: {
      encoding: 'png',
      bytes: new Uint8Array([137, 80, 78, 71]),
      devicePixelRatio: 1,
    },
    ...over,
  };
}

function mkAdapter(over: Partial<PixelGroundingAdapter> & Pick<PixelGroundingAdapter, 'id'>): PixelGroundingAdapter {
  return {
    label: over.id,
    priority: 100,
    minConfidence: 0.5,
    isReady: () => true,
    ground: async () => ({
      ok: true,
      adapterId: over.id,
      hit: { confidence: 0.9, target: { x: 100, y: 100 } },
      elapsedMs: 5,
    }),
    ...over,
  } as PixelGroundingAdapter;
}

describe('validateGroundingRequest', () => {
  it('accepts a well-formed click request', () => {
    expect(validateGroundingRequest(mkRequest()).ok).toBe(true);
  });

  it('rejects an empty target', () => {
    const r = validateGroundingRequest(mkRequest({ target: '' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/target/);
  });

  it('rejects unknown actions', () => {
    // deliberate mistype
    const req = mkRequest({ action: 'jump' as unknown as PixelGroundingRequest['action'] });
    expect(validateGroundingRequest(req).ok).toBe(false);
  });

  it('requires toTarget for drag', () => {
    const r = validateGroundingRequest(mkRequest({ action: 'drag' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/toTarget/);
  });

  it('requires text for type', () => {
    const r = validateGroundingRequest(mkRequest({ action: 'type' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/text/);
  });

  it('requires option for select', () => {
    const r = validateGroundingRequest(mkRequest({ action: 'select' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/option/);
  });

  it('rejects non-positive viewport', () => {
    const r = validateGroundingRequest(mkRequest({ viewport: { width: 0, height: 100 } }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/viewport/);
  });

  it('rejects missing screenshot bytes', () => {
    const r = validateGroundingRequest(
      mkRequest({
        screenshot: { encoding: 'png', bytes: new Uint8Array(0) },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/screenshot/);
  });
});

describe('coordinatesInViewport', () => {
  const vp = { width: 1000, height: 800 };
  it('accepts in-viewport points at dpr=1', () => {
    expect(coordinatesInViewport({ x: 500, y: 400 }, vp, 1)).toBe(true);
  });

  it('rejects negative coords', () => {
    expect(coordinatesInViewport({ x: -1, y: 10 }, vp, 1)).toBe(false);
  });

  it('scales bounds by device pixel ratio', () => {
    // With dpr=2, coords may be up to 2000×1600 in screenshot space.
    expect(coordinatesInViewport({ x: 1500, y: 1200 }, vp, 2)).toBe(true);
    expect(coordinatesInViewport({ x: 2001, y: 100 }, vp, 2)).toBe(false);
  });

  it('rejects non-finite values', () => {
    expect(coordinatesInViewport({ x: NaN, y: 0 }, vp, 1)).toBe(false);
    expect(coordinatesInViewport({ x: 0, y: Infinity }, vp, 1)).toBe(false);
  });
});

describe('PixelGroundingFallbackChain', () => {
  it('returns the first confident hit and stops there', async () => {
    const chain = new PixelGroundingFallbackChain();
    let secondCalled = false;
    chain.register(mkAdapter({ id: 'first', priority: 10 }));
    chain.register(
      mkAdapter({
        id: 'second',
        priority: 20,
        ground: async () => {
          secondCalled = true;
          return {
            ok: true,
            adapterId: 'second',
            hit: { confidence: 0.99, target: { x: 200, y: 200 } },
            elapsedMs: 1,
          };
        },
      }),
    );
    const out = await chain.ground(mkRequest());
    expect(out.ok).toBe(true);
    expect(out.adapterId).toBe('first');
    expect(secondCalled).toBe(false);
  });

  it('skips adapters that report not-ready and falls through', async () => {
    const chain = new PixelGroundingFallbackChain();
    chain.register(
      mkAdapter({
        id: 'a',
        priority: 10,
        isReady: () => false,
      }),
    );
    chain.register(mkAdapter({ id: 'b', priority: 20 }));
    const out = await chain.ground(mkRequest());
    expect(out.ok).toBe(true);
    expect(out.adapterId).toBe('b');
    expect(out.attempts.length).toBe(2);
    expect(out.attempts[0].error?.code).toBe('model_unavailable');
  });

  it('rejects hits below minConfidence and tries the next adapter', async () => {
    const chain = new PixelGroundingFallbackChain();
    chain.register(
      mkAdapter({
        id: 'weak',
        priority: 10,
        minConfidence: 0.9,
        ground: async () => ({
          ok: true,
          adapterId: 'weak',
          hit: { confidence: 0.5, target: { x: 50, y: 50 } },
          elapsedMs: 1,
        }),
      }),
    );
    chain.register(mkAdapter({ id: 'strong', priority: 20 }));
    const out = await chain.ground(mkRequest());
    expect(out.ok).toBe(true);
    expect(out.adapterId).toBe('strong');
  });

  it('rejects hits whose coordinates leave the viewport', async () => {
    const chain = new PixelGroundingFallbackChain();
    chain.register(
      mkAdapter({
        id: 'ooo',
        priority: 10,
        ground: async () => ({
          ok: true,
          adapterId: 'ooo',
          hit: { confidence: 0.99, target: { x: 999_999, y: 999_999 } },
          elapsedMs: 1,
        }),
      }),
    );
    const out = await chain.ground(mkRequest());
    expect(out.ok).toBe(false);
    expect(out.attempts.length).toBe(1);
  });

  it('validates the request before any adapter runs', async () => {
    const chain = new PixelGroundingFallbackChain();
    let called = false;
    chain.register(
      mkAdapter({
        id: 'never',
        priority: 10,
        ground: async () => {
          called = true;
          return {
            ok: true,
            adapterId: 'never',
            hit: { confidence: 1, target: { x: 0, y: 0 } },
            elapsedMs: 0,
          };
        },
      }),
    );
    const out = await chain.ground(mkRequest({ target: '' }));
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
    expect(out.attempts[0].adapterId).toBe('chain');
  });

  it('emits onAttempt for every attempt', async () => {
    const events: string[] = [];
    const chain = new PixelGroundingFallbackChain({
      onAttempt: (r: PixelGroundingResult) => events.push(r.adapterId),
    });
    chain.register(mkAdapter({ id: 'a' }));
    chain.register(mkAdapter({ id: 'b' }));
    await chain.ground(mkRequest());
    expect(events).toContain('a');
  });

  it('respects maxAttempts', async () => {
    const chain = new PixelGroundingFallbackChain({ maxAttempts: 1 });
    chain.register(
      mkAdapter({
        id: 'weak',
        priority: 10,
        minConfidence: 0.99,
        ground: async () => ({
          ok: true,
          adapterId: 'weak',
          hit: { confidence: 0.1, target: { x: 1, y: 1 } },
          elapsedMs: 1,
        }),
      }),
    );
    chain.register(mkAdapter({ id: 'strong', priority: 20 }));
    const out = await chain.ground(mkRequest());
    expect(out.ok).toBe(false);
    expect(out.attempts.length).toBe(1);
  });
});
