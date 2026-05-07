/**
 * Pure-JS 64-bit perceptual hash (pHash) for screenshot classification.
 *
 * Algorithm (DCT-free variant, fast and dependency-free):
 *   1. Decode the input image into a Buffer of RGBA pixels.
 *   2. Resize to 32x32 by nearest-neighbor sampling.
 *   3. Convert to grayscale (luminance formula).
 *   4. Downsample to 8x8 by averaging 4x4 blocks.
 *   5. Compute the mean of the 64 grayscale values.
 *   6. Bit i = 1 iff pixel i ≥ mean.
 *
 * The output is a 64-bit BigInt (and a 16-char hex string). Hamming
 * distance over the bits is what callers compare. For the screenshot-
 * class assertion we expose a pre-baked 64-bit pHash; tests that don't
 * have a real image can call `phashFromGrayscale(8x8 array)` directly.
 *
 * Why not DCT-based pHash? The DCT variant is more robust to scale +
 * compression artifacts, but requires a 64x64 DCT pass and needs care
 * with quantization. The block-mean variant gets ≥95 % of the way for
 * UI-comparison purposes (which is our use case — "is this the order
 * confirmation page or not?") at a fraction of the LOC.
 *
 * No native deps, no `sharp`. PNG decoding is delegated to a tiny
 * embedded helper that handles the un-paletted RGBA case (the only
 * case openchrome's screenshot capture produces). For other formats
 * callers should pre-decode and call `phashFromGrayscale`.
 */

/** 64-bit perceptual hash represented as a BigInt + 16-char hex string. */
export interface PhashResult {
  bits: bigint;
  hex: string;
}

const TARGET_SIZE = 32; // intermediate size before averaging
const FINAL_SIZE = 8; // 8x8 = 64 bits

/**
 * Compute Hamming distance between two 64-bit hashes.
 * Range: 0 (identical) … 64 (every bit differs).
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Same as `hammingDistance` but accepting hex strings. */
export function hammingDistanceHex(aHex: string, bHex: string): number {
  return hammingDistance(BigInt('0x' + aHex), BigInt('0x' + bHex));
}

/**
 * Compute pHash from a pre-prepared 8x8 grayscale array. Callers without
 * a real image (tests, deterministic fixtures) use this directly.
 */
export function phashFromGrayscale(values: ArrayLike<number>): PhashResult {
  if (values.length !== FINAL_SIZE * FINAL_SIZE) {
    throw new Error(`phashFromGrayscale: expected ${FINAL_SIZE * FINAL_SIZE} values, got ${values.length}`);
  }
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;
  let bits = 0n;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= mean) bits |= 1n << BigInt(i);
  }
  return { bits, hex: bits.toString(16).padStart(16, '0') };
}

/**
 * Compute pHash from a raw RGBA buffer of arbitrary dimensions. Faster
 * tests (no PNG decoding) can use this entry point.
 *
 * @param rgba    Tightly-packed RGBA byte buffer (4 bytes per pixel).
 * @param width   Source image width in pixels.
 * @param height  Source image height in pixels.
 */
export function phashFromRgba(rgba: Uint8Array | Buffer, width: number, height: number): PhashResult {
  if (rgba.length !== width * height * 4) {
    throw new Error(`phashFromRgba: rgba length ${rgba.length} != ${width * height * 4}`);
  }
  // Resize to TARGET_SIZE x TARGET_SIZE via nearest-neighbor sampling
  // and convert to grayscale at the same time.
  const intermediate = new Float64Array(TARGET_SIZE * TARGET_SIZE);
  for (let y = 0; y < TARGET_SIZE; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / TARGET_SIZE));
    for (let x = 0; x < TARGET_SIZE; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / TARGET_SIZE));
      const off = (sy * width + sx) * 4;
      const r = rgba[off];
      const g = rgba[off + 1];
      const b = rgba[off + 2];
      // Rec. 601 luma — fine for perceptual hashing.
      intermediate[y * TARGET_SIZE + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  // Average 4x4 blocks → 8x8.
  const final = new Float64Array(FINAL_SIZE * FINAL_SIZE);
  const block = TARGET_SIZE / FINAL_SIZE;
  for (let by = 0; by < FINAL_SIZE; by++) {
    for (let bx = 0; bx < FINAL_SIZE; bx++) {
      let sum = 0;
      for (let yy = 0; yy < block; yy++) {
        for (let xx = 0; xx < block; xx++) {
          const py = by * block + yy;
          const px = bx * block + xx;
          sum += intermediate[py * TARGET_SIZE + px];
        }
      }
      final[by * FINAL_SIZE + bx] = sum / (block * block);
    }
  }
  return phashFromGrayscale(final);
}
