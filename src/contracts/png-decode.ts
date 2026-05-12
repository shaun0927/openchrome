/**
 * Minimal pure-TS PNG decoder.
 *
 * Scope: 8-bit truecolour PNG (RGB / RGBA) — the format Chromium emits for
 * screenshots. We deliberately do NOT support indexed palette, grayscale,
 * 16-bit, interlaced (Adam7), APNG, or sBIT/iCCP-driven colour transforms.
 * Adding those would expand the module beyond this issue's scope; reject
 * unsupported inputs with a descriptive error so callers fail loud.
 *
 * Decoding only — there is no encoder.
 */

import { inflateSync } from 'zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** Tightly packed RGBA, row-major, 4 bytes/pixel, stride = width*4. */
  rgba: Uint8ClampedArray;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Hard cap on either dimension. 16,384 px comfortably covers a 4× DPR
 * 4K full-page screenshot while bounding any single allocation to ≈ 1 GB
 * worst case (16384 × 16384 × 4 B). Anything larger almost certainly
 * indicates a hostile or malformed input.
 */
const MAX_PNG_DIMENSION = 16384;

export function decodePng(buf: Buffer): DecodedImage {
  if (buf.length < PNG_MAGIC.length + 12) {
    throw new Error('not a PNG: buffer too short');
  }
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buf[i] !== PNG_MAGIC[i]) {
      throw new Error('not a PNG: bad magic');
    }
  }

  let cursor = PNG_MAGIC.length;
  let ihdr: { width: number; height: number; colorType: number; bitDepth: number; interlace: number } | null = null;
  const idatParts: Buffer[] = [];

  while (cursor < buf.length) {
    if (cursor + 8 > buf.length) {
      throw new Error('PNG truncated at chunk header');
    }
    const length = buf.readUInt32BE(cursor);
    const type = buf.toString('ascii', cursor + 4, cursor + 8);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`PNG truncated in chunk '${type}'`);
    }

    if (type === 'IHDR') {
      if (length !== 13) throw new Error(`malformed IHDR length=${length}`);
      ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        // 10 = compression (must be 0), 11 = filter (must be 0)
        interlace: buf[dataStart + 12],
      };
      if (ihdr.bitDepth !== 8) {
        throw new Error(`unsupported PNG bitDepth=${ihdr.bitDepth} (expected 8)`);
      }
      if (ihdr.colorType !== 2 && ihdr.colorType !== 6) {
        throw new Error(
          `unsupported PNG colorType=${ihdr.colorType} (expected 2=RGB or 6=RGBA)`,
        );
      }
      if (ihdr.interlace !== 0) {
        throw new Error('interlaced PNG (Adam7) is not supported');
      }
      if (
        ihdr.width <= 0 ||
        ihdr.height <= 0 ||
        ihdr.width > MAX_PNG_DIMENSION ||
        ihdr.height > MAX_PNG_DIMENSION
      ) {
        throw new Error(
          `PNG dimensions ${ihdr.width}x${ihdr.height} out of bounds (max ${MAX_PNG_DIMENSION})`,
        );
      }
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    // Skip CRC (4 bytes).
    cursor = dataEnd + 4;
  }

  if (ihdr === null) throw new Error('PNG missing IHDR');
  if (idatParts.length === 0) throw new Error('PNG missing IDAT');

  const compressed = Buffer.concat(idatParts);
  const channels = ihdr.colorType === 6 ? 4 : 3;
  const bpp = channels;
  const stride = ihdr.width * bpp;
  const expected = (stride + 1) * ihdr.height;
  // Cap inflate output to the size IHDR claims — defends against zip-bomb
  // payloads where a tiny IDAT inflates to gigabytes.
  const raw = inflateSync(compressed, { maxOutputLength: expected });
  if (raw.length !== expected) {
    throw new Error(
      `PNG inflated size ${raw.length} != expected ${expected} (W=${ihdr.width} H=${ihdr.height} c=${channels})`,
    );
  }

  const filtered = Buffer.alloc(stride * ihdr.height);
  let prevRowStart = -1;
  for (let y = 0; y < ihdr.height; y++) {
    const filterType = raw[y * (stride + 1)];
    const inOffset = y * (stride + 1) + 1;
    const outOffset = y * stride;
    applyFilter(filterType, raw, inOffset, filtered, outOffset, stride, bpp, prevRowStart);
    prevRowStart = outOffset;
  }

  // Convert to RGBA.
  const rgba = new Uint8ClampedArray(ihdr.width * ihdr.height * 4);
  if (channels === 4) {
    rgba.set(filtered);
  } else {
    for (let i = 0, j = 0; i < filtered.length; i += 3, j += 4) {
      rgba[j] = filtered[i];
      rgba[j + 1] = filtered[i + 1];
      rgba[j + 2] = filtered[i + 2];
      rgba[j + 3] = 0xff;
    }
  }

  return { width: ihdr.width, height: ihdr.height, rgba };
}

function applyFilter(
  type: number,
  src: Buffer,
  srcOff: number,
  dst: Buffer,
  dstOff: number,
  rowBytes: number,
  bpp: number,
  prevRowOff: number,
): void {
  switch (type) {
    case 0:
      src.copy(dst, dstOff, srcOff, srcOff + rowBytes);
      return;
    case 1:
      // Sub: x + a (left)
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? dst[dstOff + i - bpp] : 0;
        dst[dstOff + i] = (src[srcOff + i] + left) & 0xff;
      }
      return;
    case 2:
      // Up: x + b (above)
      for (let i = 0; i < rowBytes; i++) {
        const up = prevRowOff >= 0 ? dst[prevRowOff + i] : 0;
        dst[dstOff + i] = (src[srcOff + i] + up) & 0xff;
      }
      return;
    case 3:
      // Average: x + floor((a + b) / 2)
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? dst[dstOff + i - bpp] : 0;
        const up = prevRowOff >= 0 ? dst[prevRowOff + i] : 0;
        dst[dstOff + i] = (src[srcOff + i] + ((left + up) >> 1)) & 0xff;
      }
      return;
    case 4:
      // Paeth: x + Paeth(a, b, c)
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? dst[dstOff + i - bpp] : 0;
        const up = prevRowOff >= 0 ? dst[prevRowOff + i] : 0;
        const upLeft = prevRowOff >= 0 && i >= bpp ? dst[prevRowOff + i - bpp] : 0;
        dst[dstOff + i] = (src[srcOff + i] + paeth(left, up, upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter type ${type}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
