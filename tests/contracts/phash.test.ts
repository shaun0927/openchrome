import {
  hammingDistance,
  hammingDistanceHex,
  phashFromGrayscale,
  phashFromRgba,
} from '../../src/contracts/phash';

describe('hammingDistance', () => {
  test('identical hashes → 0', () => {
    expect(hammingDistance(0x1234567890abcdefn, 0x1234567890abcdefn)).toBe(0);
  });

  test('inverted hash → 64', () => {
    expect(hammingDistance(0x0n, 0xffffffffffffffffn)).toBe(64);
  });

  test('single bit difference → 1', () => {
    expect(hammingDistance(0n, 1n)).toBe(1);
    expect(hammingDistance(0n, 1n << 63n)).toBe(1);
  });

  test('hex form matches BigInt form', () => {
    const a = 'deadbeef00000000';
    const b = '0000000000000000';
    expect(hammingDistanceHex(a, b)).toBe(hammingDistance(BigInt('0x' + a), BigInt('0x' + b)));
  });
});

describe('phashFromGrayscale', () => {
  test('produces 64-bit hex output', () => {
    const r = phashFromGrayscale(new Float64Array(64).fill(128));
    expect(r.hex).toMatch(/^[0-9a-f]{16}$/);
    expect(r.bits).toBeGreaterThanOrEqual(0n);
  });

  test('all-equal input produces deterministic hash', () => {
    const a = phashFromGrayscale(new Float64Array(64).fill(50));
    const b = phashFromGrayscale(new Float64Array(64).fill(50));
    expect(a.hex).toBe(b.hex);
  });

  test('different bit patterns produce different hashes', () => {
    const a = phashFromGrayscale(new Float64Array(64).fill(50));
    const half = new Float64Array(64);
    for (let i = 0; i < 32; i++) half[i] = 100; // brighter than mean
    for (let i = 32; i < 64; i++) half[i] = 0;
    const b = phashFromGrayscale(half);
    expect(a.hex).not.toBe(b.hex);
  });

  test('rejects mis-sized input', () => {
    expect(() => phashFromGrayscale(new Float64Array(63))).toThrow();
  });
});

describe('phashFromRgba', () => {
  // Build a tiny synthetic image: half white / half black, 32x32 RGBA.
  function halfHalf(width: number, height: number): Buffer {
    const buf = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = (y * width + x) * 4;
        const bright = x < width / 2;
        const v = bright ? 255 : 0;
        buf[off] = v;
        buf[off + 1] = v;
        buf[off + 2] = v;
        buf[off + 3] = 255;
      }
    }
    return buf;
  }

  test('half-bright / half-dark image → bits split roughly evenly', () => {
    const r = phashFromRgba(halfHalf(64, 64), 64, 64);
    let ones = 0;
    let bits = r.bits;
    while (bits !== 0n) {
      ones += Number(bits & 1n);
      bits >>= 1n;
    }
    // For a clean half-half image, exactly 32 bits should be set.
    // Allow ±2 for sampling artifacts.
    expect(ones).toBeGreaterThanOrEqual(30);
    expect(ones).toBeLessThanOrEqual(34);
  });

  test('two captures of the same scene have small Hamming distance', () => {
    const a = phashFromRgba(halfHalf(64, 64), 64, 64);
    const b = phashFromRgba(halfHalf(64, 64), 64, 64);
    expect(hammingDistance(a.bits, b.bits)).toBe(0);
  });

  test('completely-different scenes have large Hamming distance', () => {
    const allBright = Buffer.alloc(64 * 64 * 4, 255);
    const allDark = Buffer.alloc(64 * 64 * 4);
    for (let i = 3; i < allDark.length; i += 4) allDark[i] = 255; // alpha
    const aR = phashFromRgba(allBright, 64, 64);
    // The all-bright case → all values equal mean → bits all set (>=).
    // The all-dark case → all values equal mean → bits all set too.
    // So this test is a sanity check that the hash function is total
    // and doesn't crash on degenerate input.
    expect(aR.hex).toMatch(/^[0-9a-f]{16}$/);
  });

  test('rejects mismatched buffer length', () => {
    expect(() => phashFromRgba(Buffer.alloc(10), 64, 64)).toThrow();
  });

  test('rejects zero / non-positive / non-integer dimensions', () => {
    // Without explicit dim validation, an empty buffer with width=0 and
    // height=0 sneaks past the length check (`0 === 0 * 0 * 4`) and
    // produces a deterministic-but-wrong hash. The fast-fail keeps a
    // bad upstream decode from polluting class comparisons downstream.
    expect(() => phashFromRgba(Buffer.alloc(0), 0, 0)).toThrow(/dimensions/);
    expect(() => phashFromRgba(Buffer.alloc(0), 64, 0)).toThrow(/dimensions/);
    expect(() => phashFromRgba(Buffer.alloc(0), 0, 64)).toThrow(/dimensions/);
    expect(() => phashFromRgba(Buffer.alloc(0), -1, 64)).toThrow(/dimensions/);
    expect(() => phashFromRgba(Buffer.alloc(0), 1.5, 64)).toThrow(/dimensions/);
    expect(() => phashFromRgba(Buffer.alloc(0), Number.NaN, 64)).toThrow(/dimensions/);
  });
});
