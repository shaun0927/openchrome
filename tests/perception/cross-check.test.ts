import { runCrossCheck } from '../../src/perception/cross-check';

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
    // Inner crop has a faint edge (low density). With default density
    // cutoff 0.02 the result is consistent; raising the cutoff makes
    // the crop appear absent.
    const buf = fieldWithInnerRect(64, 64, [bg.r, bg.g, bg.b], [bg.r - 1, bg.g - 1, bg.b - 1], {
      x: 30,
      y: 30,
      w: 4,
      h: 4,
    });
    const def = runCrossCheck(buf, 64, 64, { x: 16, y: 16, w: 32, h: 32 }, { backgroundColor: bg });
    expect(def.verdict).toBe('pixel_absent');

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
