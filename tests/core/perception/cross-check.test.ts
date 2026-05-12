import { runCrossCheck, runCrossCheckBatch } from '../../../src/core/perception/cross-check';
import * as imageFeatures from '../../../src/core/perception/image-features';
import * as zlib from 'zlib';

function solid(w: number, h: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  // The decoder under test does not validate CRCs; zeros are sufficient.
  chunk.writeUInt32BE(0, 8 + data.length);
  return chunk;
}

function pngFromRgb(w: number, h: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const stride = w * 3;
  const scanlines = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    scanlines[rowStart] = 0;
    rgb.copy(scanlines, rowStart + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function solidRgb(w: number, h: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

/** Field with `inner` filled with a different color in the central rect. */
function fieldWithInnerRect(
  w: number,
  h: number,
  outer: [number, number, number],
  inner: [number, number, number],
  innerCrop: { x: number; y: number; w: number; h: number },
): Buffer {
  const buf = solid(w, h, outer[0], outer[1], outer[2]);
  for (let y = innerCrop.y; y < innerCrop.y + innerCrop.h; y++) {
    for (let x = innerCrop.x; x < innerCrop.x + innerCrop.w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = inner[0];
      buf[i + 1] = inner[1];
      buf[i + 2] = inner[2];
    }
  }
  return buf;
}

describe('runCrossCheck — pixel_absent verdict', () => {
  test('flat region matching page background → pixel_absent', () => {
    // Whole image is the background color; the "element" lives in a
    // sub-region that's also background — no edges, no color contrast.
    const bg = { r: 240, g: 240, b: 240 };
    const buf = solid(64, 64, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 64, 64, { x: 16, y: 16, w: 32, h: 32 }, {
      backgroundColor: bg,
    });
    expect(r.verdict).toBe('pixel_absent');
    expect(r.edge_density).toBe(0);
    expect(r.color_distance).toBeLessThan(30);
  });

  test('accepts Chromium-style encoded PNG screenshots before feature extraction', () => {
    const bg = { r: 240, g: 240, b: 240 };
    const png = pngFromRgb(16, 16, solidRgb(16, 16, bg.r, bg.g, bg.b));
    const r = runCrossCheck(png, 16, 16, { x: 0, y: 0, w: 16, h: 16 }, {
      backgroundColor: bg,
    });
    expect(r.verdict).toBe('pixel_absent');
    expect(r.edge_density).toBe(0);
    expect(r.dominant_color).toEqual({ r: 240, g: 240, b: 240 });
  });
});

describe('runCrossCheck — consistent verdict', () => {
  test('region with strong edges → consistent (high edge density)', () => {
    // Half-white / half-black inner rect on a gray background. The
    // inner crop has a clear vertical edge, so density is high.
    const bg = { r: 200, g: 200, b: 200 };
    const inner = { x: 16, y: 16, w: 32, h: 32 };
    const buf = Buffer.alloc(64 * 64 * 4);
    // Fill background
    for (let i = 0; i < 64 * 64; i++) {
      buf[i * 4] = bg.r;
      buf[i * 4 + 1] = bg.g;
      buf[i * 4 + 2] = bg.b;
      buf[i * 4 + 3] = 255;
    }
    // Stripe inside the inner rect
    for (let y = inner.y; y < inner.y + inner.h; y++) {
      for (let x = inner.x; x < inner.x + inner.w; x++) {
        const i = (y * 64 + x) * 4;
        const v = x < inner.x + inner.w / 2 ? 0 : 255;
        buf[i] = v;
        buf[i + 1] = v;
        buf[i + 2] = v;
      }
    }
    const r = runCrossCheck(buf, 64, 64, inner, { backgroundColor: bg });
    expect(r.verdict).toBe('consistent');
    expect(r.edge_density).toBeGreaterThan(0.02);
  });

  test('flat region with DIFFERENT color → consistent (background mismatch)', () => {
    // A flat colored block that isn't the page background. No edges
    // (so the edge-density branch fires) but the color doesn't match
    // the background — verdict stays consistent.
    const bg = { r: 240, g: 240, b: 240 };
    const buf = fieldWithInnerRect(64, 64, [bg.r, bg.g, bg.b], [50, 100, 200], { x: 16, y: 16, w: 32, h: 32 });
    const r = runCrossCheck(buf, 64, 64, { x: 18, y: 18, w: 28, h: 28 }, {
      backgroundColor: bg,
    });
    expect(r.verdict).toBe('consistent');
    expect(r.color_distance).toBeGreaterThan(30);
  });
});

describe('runCrossCheck — overrides', () => {
  test('tolerance 0 + bucket-floor mismatch → consistent (color does NOT match)', () => {
    // dominantColor uses 16-bin quantization → bucket center for
    // 200,200,200 is 192,192,192 (distance ≈13.86 from 200). With
    // colorTolerance=0 that 13.86 distance trips the "background
    // mismatch" branch, so the verdict is `consistent` (the region is
    // a different color from the page background, even though it has
    // no edges).
    const bg = { r: 200, g: 200, b: 200 };
    const buf = solid(32, 32, 200, 200, 200);
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, {
      backgroundColor: bg,
      colorTolerance: 0,
    });
    expect(r.verdict).toBe('consistent');
    expect(r.color_distance).toBeGreaterThan(0);
  });

  test('raising edgeDensityThreshold makes a bordered region register as pixel_absent', () => {
    const bg = { r: 240, g: 240, b: 240 };
    // An 8x8 inner rect with a strongly contrasting color (channel diff > 30)
    // sits inside the 32x32 crop. Its Sobel perimeter produces ~28 edge pixels
    // out of 1024 crop pixels, giving edge_density ~0.027.
    //
    // Default threshold (0.02): 0.027 >= 0.02 → verdict is `consistent`.
    // Raised threshold (0.5):   0.027 <  0.50 → low-edge branch fires; the
    // dominant crop color is still the bg (960/1024 pixels) so color_distance
    // is near zero → verdict flips to `pixel_absent`.
    const buf = fieldWithInnerRect(64, 64, [bg.r, bg.g, bg.b], [bg.r - 50, bg.g - 50, bg.b - 50], {
      x: 20,
      y: 20,
      w: 8,
      h: 8,
    });
    const def = runCrossCheck(buf, 64, 64, { x: 16, y: 16, w: 32, h: 32 }, { backgroundColor: bg });
    expect(def.verdict).toBe('consistent');

    const tight = runCrossCheck(buf, 64, 64, { x: 16, y: 16, w: 32, h: 32 }, {
      backgroundColor: bg,
      edgeDensityThreshold: 0.5,
    });
    expect(tight.verdict).toBe('pixel_absent');
  });
});

describe('runCrossCheck — empty_region guard', () => {
  test('fully off-canvas pixelBox → empty_region verdict, not consistent', () => {
    // A 16x16 image with the crop placed entirely outside the canvas.
    // Before the fix this would return consistent (synthetic black vs bg).
    const bg = { r: 0, g: 0, b: 0 };
    const buf = solid(16, 16, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 16, 16, { x: 20, y: 20, w: 8, h: 8 }, { backgroundColor: bg });
    expect(r.verdict).toBe('empty_region');
    expect(r.dominant_color).toBeNull();
    expect(r.reasons[0]).toContain('empty rectangle');
  });

  test('zero-width crop → empty_region verdict', () => {
    const bg = { r: 240, g: 240, b: 240 };
    const buf = solid(32, 32, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 32, 32, { x: 8, y: 8, w: 0, h: 16 }, { backgroundColor: bg });
    expect(r.verdict).toBe('empty_region');
    expect(r.dominant_color).toBeNull();
  });

  test('empty_region is NOT consistent even when background is black', () => {
    // Regression for the exact false-negative: bg={0,0,0}, off-canvas crop.
    // Old code: dominantColor returned {0,0,0}, colorDistance=0, verdict=consistent.
    const bg = { r: 0, g: 0, b: 0 };
    const buf = solid(8, 8, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 8, 8, { x: 100, y: 100, w: 10, h: 10 }, { backgroundColor: bg });
    expect(r.verdict).not.toBe('consistent');
    expect(r.verdict).toBe('empty_region');
  });
});

describe('runCrossCheck — invalid override thresholds fall back to defaults', () => {
  // A flat region matching the background → pixel_absent with defaults.
  // If NaN/Infinity/-1 were used raw, edgeDensity < NaN is always false
  // and the verdict would wrongly stay `consistent`.
  function flatBgSetup() {
    const bg = { r: 240, g: 240, b: 240 };
    const buf = solid(32, 32, bg.r, bg.g, bg.b);
    return { bg, buf };
  }

  test('NaN edgeDensityThreshold → falls back to default, cloak detection still works', () => {
    const { bg, buf } = flatBgSetup();
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, {
      backgroundColor: bg,
      edgeDensityThreshold: NaN,
    });
    expect(r.verdict).toBe('pixel_absent');
  });

  test('Infinity edgeDensityThreshold → falls back to default, cloak detection still works', () => {
    const { bg, buf } = flatBgSetup();
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, {
      backgroundColor: bg,
      edgeDensityThreshold: Infinity,
    });
    expect(r.verdict).toBe('pixel_absent');
  });

  test('negative edgeDensityThreshold → falls back to default, cloak detection still works', () => {
    const { bg, buf } = flatBgSetup();
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, {
      backgroundColor: bg,
      edgeDensityThreshold: -1,
    });
    expect(r.verdict).toBe('pixel_absent');
  });

  test('valid edgeDensityThreshold 0.5 is applied (raises cutoff → pixel_absent for flat region)', () => {
    const { bg, buf } = flatBgSetup();
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, {
      backgroundColor: bg,
      edgeDensityThreshold: 0.5,
    });
    // edge_density is 0 for a flat region, still below 0.5 → pixel_absent
    expect(r.verdict).toBe('pixel_absent');
    expect(r.edge_density).toBeLessThan(0.5);
  });
});

describe('runCrossCheck — NaN crop coordinates treated as empty_region (round-7 regression)', () => {
  test('NaN crop.x → empty_region, not consistent', () => {
    const bg = { r: 240, g: 240, b: 240 };
    const buf = solid(32, 32, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 32, 32, { x: NaN, y: 0, w: 32, h: 32 }, { backgroundColor: bg });
    expect(r.verdict).toBe('empty_region');
    expect(r.dominant_color).toBeNull();
  });

  test('NaN crop.h → empty_region, not consistent', () => {
    const bg = { r: 0, g: 0, b: 0 };
    const buf = solid(32, 32, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: NaN }, { backgroundColor: bg });
    expect(r.verdict).toBe('empty_region');
    expect(r.dominant_color).toBeNull();
  });

  test('Infinity crop.w → empty_region, not consistent', () => {
    const bg = { r: 255, g: 255, b: 255 };
    const buf = solid(32, 32, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: Infinity, h: 32 }, { backgroundColor: bg });
    expect(r.verdict).toBe('empty_region');
    expect(r.dominant_color).toBeNull();
  });
});

describe('runCrossCheck — invalid backgroundColor is fail-closed (round-8 regression)', () => {
  // A non-finite backgroundColor channel makes colorDistance return NaN,
  // and NaN <= colorTolerance is always false, so the old code silently
  // kept verdict='consistent' for any crop. The fix validates the color
  // and returns a non-consistent verdict with a warning.

  test('backgroundColor with NaN channel → verdict is NOT consistent; warning emitted', () => {
    const bg = { r: NaN, g: 0, b: 0 };
    const buf = (() => {
      const b = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        b[i * 4] = 240; b[i * 4 + 1] = 240; b[i * 4 + 2] = 240; b[i * 4 + 3] = 255;
      }
      return b;
    })();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = runCrossCheck(buf, 16, 16, { x: 0, y: 0, w: 16, h: 16 }, { backgroundColor: bg });
      expect(r.verdict).not.toBe('consistent');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('backgroundColor'));
    } finally {
      spy.mockRestore();
    }
  });

  test('backgroundColor with Infinity channel → verdict is NOT consistent', () => {
    const bg = { r: 0, g: Infinity, b: 0 };
    const buf = (() => {
      const b = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        b[i * 4] = 240; b[i * 4 + 1] = 240; b[i * 4 + 2] = 240; b[i * 4 + 3] = 255;
      }
      return b;
    })();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = runCrossCheck(buf, 16, 16, { x: 0, y: 0, w: 16, h: 16 }, { backgroundColor: bg });
      expect(r.verdict).not.toBe('consistent');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runCrossCheck — P2 regression: raw RGBA whose first 4 bytes match PNG header must NOT throw', () => {
  test('raw RGBA with first pixel [0x89, 0x50, 0x4e, 0x47] is processed as raw, not decoded as PNG', () => {
    // Construct a 2x1 RGBA buffer whose first pixel is (0x89, 0x50, 0x4e, 0x47).
    // The old 4-byte sniff would have entered decodePngToRgba and thrown
    // "input is not an encoded PNG buffer" (the full 8-byte signature fails).
    // The new 8-byte sniff correctly identifies this as raw RGBA.
    const w = 2;
    const h = 1;
    const buf = Buffer.alloc(w * h * 4);
    // First pixel: bytes that match 4-byte PNG prefix but NOT the full 8-byte signature
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    // Second pixel: plain white
    buf[4] = 255; buf[5] = 255; buf[6] = 255; buf[7] = 255;

    const bg = { r: 0x80, g: 0x50, b: 0x40 };
    expect(() =>
      runCrossCheck(buf, w, h, { x: 0, y: 0, w, h }, { backgroundColor: bg }),
    ).not.toThrow();
  });
});

describe('runCrossCheckBatch — P1 regression: PNG decoded exactly once for multiple crops', () => {
  test('decodePngToRgba is called once regardless of annotation count', () => {
    const bg = { r: 240, g: 240, b: 240 };
    const png = pngFromRgb(32, 32, solidRgb(32, 32, bg.r, bg.g, bg.b));
    const spy = jest.spyOn(imageFeatures, 'decodePngToRgba');

    const crops = [
      { x: 0, y: 0, w: 8, h: 8 },
      { x: 8, y: 0, w: 8, h: 8 },
      { x: 16, y: 0, w: 8, h: 8 },
      { x: 0, y: 8, w: 8, h: 8 },
      { x: 8, y: 8, w: 8, h: 8 },
    ];
    const results = runCrossCheckBatch(png, 32, 32, crops, { backgroundColor: bg });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(crops.length);
    results.forEach((r) => expect(r.verdict).toBe('pixel_absent'));

    spy.mockRestore();
  });

  test('runCrossCheckBatch with raw RGBA does not call decodePngToRgba', () => {
    const bg = { r: 240, g: 240, b: 240 };
    const buf = solid(16, 16, bg.r, bg.g, bg.b);
    const spy = jest.spyOn(imageFeatures, 'decodePngToRgba');

    const results = runCrossCheckBatch(buf, 16, 16, [{ x: 0, y: 0, w: 16, h: 16 }], { backgroundColor: bg });

    expect(spy).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('pixel_absent');

    spy.mockRestore();
  });
});

describe('runCrossCheck — reasons surface for hint engine evidence', () => {
  test('pixel_absent path includes both edge_density and color_distance reasons', () => {
    const bg = { r: 240, g: 240, b: 240 };
    const buf = solid(32, 32, bg.r, bg.g, bg.b);
    const r = runCrossCheck(buf, 32, 32, { x: 0, y: 0, w: 32, h: 32 }, { backgroundColor: bg });
    expect(r.verdict).toBe('pixel_absent');
    expect(r.reasons.some((s) => s.includes('edge_density'))).toBe(true);
    expect(r.reasons.some((s) => s.includes('color_distance'))).toBe(true);
  });

  test('consistent (edge-density branch) path emits a single edge_density reason', () => {
    const bg = { r: 240, g: 240, b: 240 };
    // Region with an internal sharp edge → high density → consistent.
    const inner = { x: 8, y: 8, w: 16, h: 16 };
    const buf = Buffer.alloc(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      buf[i * 4] = bg.r;
      buf[i * 4 + 1] = bg.g;
      buf[i * 4 + 2] = bg.b;
      buf[i * 4 + 3] = 255;
    }
    for (let y = inner.y; y < inner.y + inner.h; y++) {
      for (let x = inner.x; x < inner.x + inner.w; x++) {
        const i = (y * 32 + x) * 4;
        const v = x < inner.x + inner.w / 2 ? 0 : 255;
        buf[i] = v;
        buf[i + 1] = v;
        buf[i + 2] = v;
      }
    }
    const r = runCrossCheck(buf, 32, 32, inner, { backgroundColor: bg });
    expect(r.verdict).toBe('consistent');
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toContain('edge_density');
  });
});
