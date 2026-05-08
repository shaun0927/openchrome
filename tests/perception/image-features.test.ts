import {
  DEFAULT_EDGE_GRADIENT_THRESHOLD,
  colorDistance,
  dominantColor,
  sobelEdgeDensity,
} from '../../src/perception/image-features';

/* ------------------------------------------------------------------ */
/* RGBA fixture builders                                               */
/* ------------------------------------------------------------------ */

function solid(width: number, height: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

/** Vertical stripe pattern: half black, half white. Strong edges. */
function verticalStripe(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = x < width / 2 ? 0 : 255;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

/** Single pixel of contrasting color in an otherwise-solid field. */
function withPixel(
  base: Buffer,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  const buf = Buffer.from(base);
  const i = (y * width + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  return buf;
}

/* ------------------------------------------------------------------ */
/* sobelEdgeDensity                                                    */
/* ------------------------------------------------------------------ */

describe('sobelEdgeDensity', () => {
  test('solid field → 0 edge density', () => {
    const buf = solid(32, 32, 200, 200, 200);
    const d = sobelEdgeDensity(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 });
    expect(d).toBe(0);
  });

  test('vertical stripe (sharp transition) → high edge density along the boundary', () => {
    const buf = verticalStripe(32, 32);
    // Sample only the column where the boundary sits (x=15..16) — should be hot.
    const d = sobelEdgeDensity(buf, 32, 32, { x: 14, y: 0, w: 4, h: 32 });
    expect(d).toBeGreaterThan(0.4);
  });

  test('vertical stripe (full image) → moderate aggregate density', () => {
    const buf = verticalStripe(32, 32);
    const d = sobelEdgeDensity(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 });
    // The boundary covers 2/32 columns ≈ 6.25 % of pixels but Sobel
    // also lights up the neighboring column ⇒ density in [0.04, 0.15].
    expect(d).toBeGreaterThan(0.03);
    expect(d).toBeLessThan(0.2);
  });

  test('out-of-bounds crop is clamped without throw', () => {
    const buf = solid(8, 8, 100, 100, 100);
    expect(sobelEdgeDensity(buf, 8, 8, { x: -10, y: -10, w: 32, h: 32 })).toBe(0);
  });

  test('zero-area crop → 0', () => {
    const buf = solid(8, 8, 100, 100, 100);
    expect(sobelEdgeDensity(buf, 8, 8, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
  });

  test('rejects buffer length / dimension mismatch', () => {
    expect(() => sobelEdgeDensity(Buffer.alloc(10), 8, 8, { x: 0, y: 0, w: 1, h: 1 })).toThrow();
  });

  test('threshold tunable: a very high threshold zeros out density on a striped image', () => {
    // Vertical stripe has finite Sobel magnitudes (~510 at the
    // boundary, 0 elsewhere). Pushing the threshold beyond 510 — 1000
    // is plenty — drops density to zero. Default threshold (30) leaves
    // a nontrivial density. This is the cleanest "threshold tunable"
    // test that doesn't depend on subtle anomaly arithmetic.
    const buf = verticalStripe(32, 32);
    const def = sobelEdgeDensity(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, DEFAULT_EDGE_GRADIENT_THRESHOLD);
    const huge = sobelEdgeDensity(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, 10_000);
    expect(def).toBeGreaterThan(0);
    expect(huge).toBe(0);
    expect(def).toBeGreaterThan(huge);
  });
});

/* ------------------------------------------------------------------ */
/* colorDistance                                                       */
/* ------------------------------------------------------------------ */

describe('colorDistance', () => {
  test('identical → 0', () => {
    expect(colorDistance({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 })).toBe(0);
  });

  test('black ↔ white ≈ 441', () => {
    const d = colorDistance({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(d).toBeCloseTo(441.67, 0);
  });

  test('symmetric: d(a,b) === d(b,a)', () => {
    const a = { r: 50, g: 100, b: 150 };
    const b = { r: 200, g: 80, b: 30 };
    expect(colorDistance(a, b)).toBeCloseTo(colorDistance(b, a));
  });
});

/* ------------------------------------------------------------------ */
/* dominantColor                                                       */
/* ------------------------------------------------------------------ */

describe('dominantColor', () => {
  test('solid field → that color (modulo 16-bin quantization)', () => {
    const buf = solid(16, 16, 200, 100, 50);
    const d = dominantColor(buf, 16, 16);
    // A full-image crop is never empty, so null is not expected here.
    expect(d).not.toBeNull();
    // 16-bin: 200 → 192, 100 → 96, 50 → 48
    expect(d!.r).toBe(192);
    expect(d!.g).toBe(96);
    expect(d!.b).toBe(48);
  });

  test('region restricts the sampled area', () => {
    // Top half white, bottom half black — restrict to bottom half only
    const buf = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        const v = y < 8 ? 255 : 0;
        buf[i] = v;
        buf[i + 1] = v;
        buf[i + 2] = v;
        buf[i + 3] = 255;
      }
    }
    expect(dominantColor(buf, 16, 16, { x: 0, y: 8, w: 16, h: 8 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(dominantColor(buf, 16, 16, { x: 0, y: 0, w: 16, h: 8 })).toEqual({ r: 240, g: 240, b: 240 });
  });

  test('zero-width region → null sentinel (not {0,0,0})', () => {
    const buf = solid(16, 16, 200, 100, 50);
    expect(dominantColor(buf, 16, 16, { x: 4, y: 4, w: 0, h: 8 })).toBeNull();
  });

  test('zero-height region → null sentinel (not {0,0,0})', () => {
    const buf = solid(16, 16, 200, 100, 50);
    expect(dominantColor(buf, 16, 16, { x: 4, y: 4, w: 8, h: 0 })).toBeNull();
  });

  test('fully off-canvas region clamps to empty → null sentinel', () => {
    const buf = solid(16, 16, 200, 100, 50);
    // x=20 is beyond width=16, so clamped x0=x1=16 → empty
    expect(dominantColor(buf, 16, 16, { x: 20, y: 0, w: 8, h: 8 })).toBeNull();
  });
});
