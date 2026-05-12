import { pixelRgb, rgbAt, luma } from '../../../src/core/perception/image-features';

/** Build a minimal solid-color RGBA buffer. */
function solidRgba(w: number, h: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

describe('luma', () => {
  test('black → 0', () => {
    expect(luma(0, 0, 0)).toBe(0);
  });

  test('white → ~255', () => {
    expect(luma(255, 255, 255)).toBeCloseTo(255, 1);
  });

  test('Rec.601 weighting', () => {
    expect(luma(255, 0, 0)).toBeCloseTo(76.245, 1);
    expect(luma(0, 255, 0)).toBeCloseTo(149.685, 1);
    expect(luma(0, 0, 255)).toBeCloseTo(29.07, 1);
  });
});

describe('pixelRgb — normal inputs', () => {
  const buf = solidRgba(4, 4, 100, 150, 200);

  test('center pixel returns correct color', () => {
    expect(pixelRgb(buf, 4, 4, 2, 2)).toEqual({ r: 100, g: 150, b: 200 });
  });

  test('x out-of-bounds (> w-1) clamps to right edge', () => {
    expect(pixelRgb(buf, 4, 4, 10, 0)).toEqual({ r: 100, g: 150, b: 200 });
  });

  test('y out-of-bounds (> h-1) clamps to bottom edge', () => {
    expect(pixelRgb(buf, 4, 4, 0, 10)).toEqual({ r: 100, g: 150, b: 200 });
  });

  test('negative x clamps to left edge', () => {
    expect(pixelRgb(buf, 4, 4, -5, 0)).toEqual({ r: 100, g: 150, b: 200 });
  });

  test('negative y clamps to top edge', () => {
    expect(pixelRgb(buf, 4, 4, 0, -5)).toEqual({ r: 100, g: 150, b: 200 });
  });
});

describe('pixelRgb — zero-dimension guard', () => {
  const emptyBuf = Buffer.alloc(0);

  test('w=0 returns {r:0, g:0, b:0} without throwing', () => {
    expect(pixelRgb(emptyBuf, 0, 4, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('h=0 returns {r:0, g:0, b:0} without throwing', () => {
    expect(pixelRgb(emptyBuf, 4, 0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('w=0, h=0 returns {r:0, g:0, b:0} without throwing', () => {
    expect(pixelRgb(emptyBuf, 0, 0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('rgbAt — normal inputs', () => {
  const buf = solidRgba(3, 3, 10, 20, 30);

  test('center pixel returns correct tuple', () => {
    expect(rgbAt(buf, 3, 3, 1, 1)).toEqual([10, 20, 30]);
  });

  test('x out-of-bounds clamps to right edge', () => {
    expect(rgbAt(buf, 3, 3, 99, 0)).toEqual([10, 20, 30]);
  });

  test('y out-of-bounds clamps to bottom edge', () => {
    expect(rgbAt(buf, 3, 3, 0, 99)).toEqual([10, 20, 30]);
  });

  test('negative x clamps to left edge', () => {
    expect(rgbAt(buf, 3, 3, -1, 0)).toEqual([10, 20, 30]);
  });

  test('negative y clamps to top edge', () => {
    expect(rgbAt(buf, 3, 3, 0, -1)).toEqual([10, 20, 30]);
  });
});

describe('rgbAt — zero-dimension guard', () => {
  const emptyBuf = Buffer.alloc(0);

  test('w=0 returns [0,0,0] without throwing', () => {
    expect(rgbAt(emptyBuf, 0, 4, 0, 0)).toEqual([0, 0, 0]);
  });

  test('h=0 returns [0,0,0] without throwing', () => {
    expect(rgbAt(emptyBuf, 4, 0, 0, 0)).toEqual([0, 0, 0]);
  });

  test('w=0, h=0 returns [0,0,0] without throwing', () => {
    expect(rgbAt(emptyBuf, 0, 0, 0, 0)).toEqual([0, 0, 0]);
  });
});

describe('pixelRgb and rgbAt — consistent coordinate→index via coordToIndex', () => {
  // 2×2 RGBA: top-left=red, top-right=green, bottom-left=blue, bottom-right=white
  const buf = Buffer.from([
    255, 0, 0, 255,   // (0,0) red
    0, 255, 0, 255,   // (1,0) green
    0, 0, 255, 255,   // (0,1) blue
    255, 255, 255, 255, // (1,1) white
  ]);

  test('pixelRgb reads distinct corner pixels correctly', () => {
    expect(pixelRgb(buf, 2, 2, 0, 0)).toEqual({ r: 255, g: 0, b: 0 });
    expect(pixelRgb(buf, 2, 2, 1, 0)).toEqual({ r: 0, g: 255, b: 0 });
    expect(pixelRgb(buf, 2, 2, 0, 1)).toEqual({ r: 0, g: 0, b: 255 });
    expect(pixelRgb(buf, 2, 2, 1, 1)).toEqual({ r: 255, g: 255, b: 255 });
  });

  test('rgbAt reads distinct corner pixels correctly', () => {
    expect(rgbAt(buf, 2, 2, 0, 0)).toEqual([255, 0, 0]);
    expect(rgbAt(buf, 2, 2, 1, 0)).toEqual([0, 255, 0]);
    expect(rgbAt(buf, 2, 2, 0, 1)).toEqual([0, 0, 255]);
    expect(rgbAt(buf, 2, 2, 1, 1)).toEqual([255, 255, 255]);
  });
});
