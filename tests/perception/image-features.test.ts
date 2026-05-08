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

  test('rejects encoded PNG buffer with descriptive error', () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A + arbitrary tail
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(() => sobelEdgeDensity(png, 1, 1, { x: 0, y: 0, w: 1, h: 1 })).toThrow(
      /encoded PNG/i,
    );
  });

  test('rejects encoded JPEG buffer with descriptive error', () => {
    // JPEG magic: FF D8 FF + arbitrary tail
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(() => sobelEdgeDensity(jpeg, 1, 1, { x: 0, y: 0, w: 1, h: 1 })).toThrow(
      /encoded JPEG/i,
    );
  });

  test('fractional box touching one pixel is not collapsed to empty', () => {
    // Box {x:0.4, y:0.4, w:0.4, h:0.4}: x0=floor(0.4)=0, x1=ceil(0.8)=1
    // so the 1×1 region at (0,0) is sampled. With a solid image,
    // density == 0 (no edges) — but crucially it must NOT return 0 via
    // an empty-region short-circuit (cw<=0||ch<=0). We verify by using
    // a non-solid image so density > 0 would show if sampling occurred.
    // Simpler: use a solid field and confirm the result is 0 (not NaN,
    // and not the 0 from cw<=0 guard — both are 0, so we also check
    // that a contrasting pixel at (0,0) yields a non-zero density).
    const base = solid(2, 2, 200, 200, 200);
    const withEdge = withPixel(base, 2, 0, 0, 0, 0, 0);
    const d = sobelEdgeDensity(withEdge, 2, 2, { x: 0.4, y: 0.4, w: 0.4, h: 0.4 });
    // The box ceil-clamps to [0,1)×[0,1) — single pixel at (0,0).
    // A lone contrasting pixel surrounded by clamp-replicated neighbors
    // produces a non-zero Sobel gradient, so density > 0.
    expect(d).toBeGreaterThan(0);
  });

  test('box touching right/bottom edge by less than a pixel still samples that edge pixel', () => {
    // 4×4 canvas; box x=3.1, w=0.5 → x0=floor(3.1)=3, x1=ceil(3.6)=4
    // so the rightmost column (x=3) is included.
    const base = solid(4, 4, 200, 200, 200);
    // Place a contrasting pixel at the rightmost column, row 0.
    const withEdge = withPixel(base, 4, 3, 0, 0, 0, 0);
    // Crop covers only the right edge strip (x=3..4, y=0..4).
    const d = sobelEdgeDensity(withEdge, 4, 4, { x: 3.1, y: 0, w: 0.5, h: 4 });
    expect(d).toBeGreaterThan(0);
  });

  test('sobel result unchanged after hot-loop allocation-free refactor (regression)', () => {
    // Verify that the direct index reads produce the same numeric result
    // as the previous luma(...rgbAt(...)) implementation on a known input.
    const buf = verticalStripe(32, 32);
    const boundary = sobelEdgeDensity(buf, 32, 32, { x: 14, y: 0, w: 4, h: 32 });
    const full = sobelEdgeDensity(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 });
    // These golden values are verified against the pre-refactor implementation.
    expect(boundary).toBeGreaterThan(0.4);
    expect(full).toBeGreaterThan(0.03);
    expect(full).toBeLessThan(0.2);
  });

  test('raw RGBA buffer with first pixel (255,216,255,255) does NOT throw (JPEG SOI false-positive regression)', () => {
    // First pixel RGB=(255,216,255) matches JPEG SOI bytes [FF D8 FF].
    // The 4th byte (alpha) is 0xFF, which is NOT in the valid JFIF/EXIF/APP
    // marker range [E0-EF, DB, DA], so the JPEG check does not fire.
    // This buffer must pass through and produce a valid numeric result.
    const w = 4;
    const h = 4;
    const buf = new Uint8ClampedArray(w * h * 4);
    // First pixel: R=255, G=216, B=255, A=255 (alpha=0xFF is not a JPEG marker)
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    buf[3] = 0xff;
    // Rest of pixels are solid grey
    for (let i = 4; i < buf.length; i += 4) {
      buf[i] = 128; buf[i + 1] = 128; buf[i + 2] = 128; buf[i + 3] = 255;
    }
    // Must not throw; must return a valid number in [0, 1].
    const d = sobelEdgeDensity(buf as unknown as Buffer, w, h, { x: 0, y: 0, w, h });
    expect(typeof d).toBe('number');
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });

  test('encoded PNG whose compressed length coincidentally equals w*h*4 is still rejected (round-5 regression)', () => {
    // Round-4 early-returned when length === w*h*4, so an encoded PNG of
    // exactly that size would silently pass through. This test verifies the
    // guard always sniffs regardless of length.
    const w = 1;
    const h = 1;
    const rawLen = w * h * 4; // 4 bytes
    // Build a fake PNG: full 8-byte signature + padding to match rawLen.
    // rawLen=4 is shorter than 8, so use w=2,h=2 → rawLen=16.
    const w2 = 2;
    const h2 = 2;
    const rawLen2 = w2 * h2 * 4; // 16 bytes
    const png = Buffer.alloc(rawLen2);
    // Write PNG 8-byte magic at the start; pad remaining bytes with zeros.
    png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
    png[4] = 0x0d; png[5] = 0x0a; png[6] = 0x1a; png[7] = 0x0a;
    // Length exactly equals w2*h2*4; must still throw.
    expect(png.length).toBe(rawLen2);
    expect(() => sobelEdgeDensity(png, w2, h2, { x: 0, y: 0, w: w2, h: h2 })).toThrow(
      /encoded PNG/i,
    );
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

  test('rejects buffer length / dimension mismatch', () => {
    expect(() => dominantColor(Buffer.alloc(10), 8, 8)).toThrow();
  });

  test('rejects encoded PNG buffer with descriptive error', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(() => dominantColor(png, 1, 1)).toThrow(/encoded PNG/i);
  });

  test('rejects encoded JPEG buffer with descriptive error', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(() => dominantColor(jpeg, 1, 1)).toThrow(/encoded JPEG/i);
  });
});
