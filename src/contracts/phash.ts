/**
 * 64-bit perceptual hash (pHash) — DCT-based.
 *
 * Algorithm (deterministic; no native deps):
 *   1. Convert RGBA to luminance (Rec. 601: 0.299 R + 0.587 G + 0.114 B).
 *   2. Box-average resize to 32x32.
 *   3. 2D DCT-II on the 32x32 luminance grid.
 *   4. Take the top-left 8x8 sub-block (low frequencies).
 *   5. Compute the median over those 64 coefficients EXCLUDING the
 *      DC coefficient at [0][0] (it dominates and would bias the bits).
 *   6. Bit i = 1 iff coefficient i > median, scanned row-major over 8x8.
 *
 * Returns a `bigint` (64 bits). Distance is Hamming over the bigint.
 */

import { decodePng, type DecodedImage } from './png-decode';

const HASH_SIZE = 8;
const DCT_SIZE = 32;

let dctCosineMatrix: Float64Array | null = null;

/** Compute pHash from already-decoded RGBA pixels. */
export function phashFromRgba(image: DecodedImage): bigint {
  if (image.width <= 0 || image.height <= 0) {
    throw new Error(`pHash requires positive dimensions (got ${image.width}x${image.height})`);
  }
  const grayscale = rgbaToGrayscale(image);
  const resized = boxResize(grayscale, image.width, image.height, DCT_SIZE, DCT_SIZE);
  const dct = dct2d(resized, DCT_SIZE);
  const lowFreq = new Float64Array(HASH_SIZE * HASH_SIZE);
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      lowFreq[v * HASH_SIZE + u] = dct[v * DCT_SIZE + u];
    }
  }
  // Median over all but the DC coefficient (index 0).
  const sorted = Array.from(lowFreq.slice(1)).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  let hash = 0n;
  for (let i = 0; i < HASH_SIZE * HASH_SIZE; i++) {
    if (lowFreq[i] > median) {
      hash |= 1n << BigInt(i);
    }
  }
  return hash;
}

/** Compute pHash directly from a PNG buffer. */
export function phashFromPng(buf: Buffer): bigint {
  return phashFromRgba(decodePng(buf));
}

/** Hamming distance between two 64-bit hashes. Result is in [0, 64]. */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Encode a 64-bit pHash as 16 lowercase hex chars. */
export function phashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

/** Decode a 16-char hex string to a 64-bit pHash. */
export function phashFromHex(hex: string): bigint {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) {
    throw new Error(`invalid pHash hex: ${hex}`);
  }
  return BigInt('0x' + hex);
}

// ─── Internals ───────────────────────────────────────────────────────────────

function rgbaToGrayscale(image: DecodedImage): Float64Array {
  const out = new Float64Array(image.width * image.height);
  const px = image.rgba;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    out[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }
  return out;
}

/**
 * Area-average (box filter) resize. Each output pixel is the unweighted mean
 * of the source pixels covered by its rectangular footprint, with edge cells
 * weighted by the fractional overlap. This is the standard "boxAverage"
 * resize used by reference pHash implementations.
 */
function boxResize(
  src: Float64Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float64Array {
  const out = new Float64Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = dy * yRatio;
    const y1 = (dy + 1) * yRatio;
    const yStart = Math.floor(y0);
    const yEnd = Math.min(srcH - 1, Math.floor(y1 - Number.EPSILON));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = dx * xRatio;
      const x1 = (dx + 1) * xRatio;
      const xStart = Math.floor(x0);
      const xEnd = Math.min(srcW - 1, Math.floor(x1 - Number.EPSILON));

      let total = 0;
      let weight = 0;
      for (let sy = yStart; sy <= yEnd; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = xStart; sx <= xEnd; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const w = wx * wy;
          total += src[sy * srcW + sx] * w;
          weight += w;
        }
      }
      out[dy * dstW + dx] = weight > 0 ? total / weight : 0;
    }
  }
  return out;
}

function getDctCosines(): Float64Array {
  if (dctCosineMatrix !== null) return dctCosineMatrix;
  const m = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let k = 0; k < DCT_SIZE; k++) {
    for (let n = 0; n < DCT_SIZE; n++) {
      m[k * DCT_SIZE + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * DCT_SIZE));
    }
  }
  dctCosineMatrix = m;
  return m;
}

/**
 * Separable DCT-II on an N×N grid. Output normalisation does NOT include
 * the orthonormal scale because pHash only cares about relative ordering
 * within the kept block.
 */
function dct2d(input: Float64Array, n: number): Float64Array {
  const cos = getDctCosines();
  const tmp = new Float64Array(n * n);
  // Rows: out[u, x] = sum_n input[x, n] * cos[u, n]
  for (let x = 0; x < n; x++) {
    for (let u = 0; u < n; u++) {
      let sum = 0;
      for (let nn = 0; nn < n; nn++) {
        sum += input[x * n + nn] * cos[u * n + nn];
      }
      tmp[x * n + u] = sum;
    }
  }
  // Cols: dct[v, u] = sum_x tmp[x, u] * cos[v, x]
  const out = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      let sum = 0;
      for (let x = 0; x < n; x++) {
        sum += tmp[x * n + u] * cos[v * n + x];
      }
      out[v * n + u] = sum;
    }
  }
  return out;
}
