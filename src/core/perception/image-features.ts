import * as zlib from 'zlib';

/**
 * Image feature primitives for the cross-check module (#710 v2).
 *
 * Pure JS, dependency-free — no sharp, no native bindings. The low-level
 * feature functions accept tightly-packed RGBA byte buffers (4 bytes per
 * pixel); callers that receive Puppeteer's default encoded PNG screenshots
 * can decode them with `decodePngToRgba` first.
 *
 * Per #710 v2 detection algorithm:
 *   - Edge density via 3x3 Sobel on grayscale; "high-gradient" pixel
 *     iff |∇I| > EDGE_GRADIENT_THRESHOLD (default 30 on 0-255 scale)
 *   - Color distance via sRGB Euclidean: sqrt(dR² + dG² + dB²)
 *   - Background match iff color distance ≤ COLOR_BG_TOLERANCE (30)
 *
 * The thresholds are exposed as overridable constants — calibration
 * lives in #710's PR-17b once the fixture corpus exists. Hosts can
 * override via env (`OPENCHROME_CROSS_CHECK_EDGE_THRESHOLD`,
 * `OPENCHROME_CROSS_CHECK_COLOR_TOLERANCE`).
 */

/** PNG magic bytes: full 8-byte signature 89 50 4E 47 0D 0A 1A 0A */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** JPEG SOI marker: FF D8 FF */
const JPEG_SOI = [0xff, 0xd8, 0xff] as const;

export interface DecodedRgbaImage {
  rgba: Buffer;
  width: number;
  height: number;
}

export function isPngBuffer(input: Uint8Array | Buffer): boolean {
  return input.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => input[i] === b);
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

/**
 * Decode a non-interlaced 8-bit PNG screenshot into raw RGBA bytes.
 *
 * This deliberately supports the PNG variants produced by Chromium
 * screenshots: truecolor RGB and truecolor-alpha RGBA. Palette,
 * grayscale, high-bit-depth, and interlaced PNGs should be decoded by
 * a real image library before they reach this module.
 */
export function decodePngToRgba(input: Uint8Array | Buffer): DecodedRgbaImage {
  if (!isPngBuffer(input)) {
    throw new Error('decodePngToRgba: input is not an encoded PNG buffer');
  }

  let offset = PNG_MAGIC.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compressionMethod = 0;
  let filterMethod = 0;
  let interlaceMethod = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 12 <= input.length) {
    const length = Buffer.from(input.subarray(offset, offset + 4)).readUInt32BE(0);
    const type = Buffer.from(input.subarray(offset + 4, offset + 8)).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > input.length) {
      throw new Error(`decodePngToRgba: truncated PNG chunk ${type}`);
    }
    const data = input.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (length !== 13) throw new Error('decodePngToRgba: invalid IHDR length');
      width = Buffer.from(data.subarray(0, 4)).readUInt32BE(0);
      height = Buffer.from(data.subarray(4, 8)).readUInt32BE(0);
      bitDepth = data[8];
      colorType = data[9];
      compressionMethod = data[10];
      filterMethod = data[11];
      interlaceMethod = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!width || !height) throw new Error('decodePngToRgba: missing or invalid IHDR dimensions');
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`decodePngToRgba: unsupported PNG color format bitDepth=${bitDepth} colorType=${colorType}`);
  }
  if (compressionMethod !== 0 || filterMethod !== 0 || interlaceMethod !== 0) {
    throw new Error('decodePngToRgba: unsupported PNG compression/filter/interlace method');
  }
  if (idatChunks.length === 0) throw new Error('decodePngToRgba: missing IDAT data');

  const channels = colorType === 6 ? 4 : 3;
  const rawStride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const expectedLength = (rawStride + 1) * height;
  if (inflated.length < expectedLength) {
    throw new Error(`decodePngToRgba: inflated data too short ${inflated.length} < ${expectedLength}`);
  }

  const reconstructed = Buffer.alloc(rawStride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    const rowStart = y * rawStride;
    const prevRowStart = rowStart - rawStride;
    for (let x = 0; x < rawStride; x++) {
      const raw = inflated[sourceOffset++];
      const left = x >= channels ? reconstructed[rowStart + x - channels] : 0;
      const up = y > 0 ? reconstructed[prevRowStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? reconstructed[prevRowStart + x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, up, upLeft);
          break;
        default:
          throw new Error(`decodePngToRgba: unsupported PNG filter type ${filter}`);
      }
      reconstructed[rowStart + x] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < reconstructed.length; i += channels, j += 4) {
    rgba[j] = reconstructed[i];
    rgba[j + 1] = reconstructed[i + 1];
    rgba[j + 2] = reconstructed[i + 2];
    rgba[j + 3] = channels === 4 ? reconstructed[i + 3] : 255;
  }

  return { rgba, width, height };
}

/**
 * Sniff the first bytes of a buffer and throw a descriptive error if it
 * looks like an encoded PNG or JPEG rather than raw RGBA bytes.
 *
 * The sniff ALWAYS runs — it is NOT gated on whether the buffer length
 * happens to match `w*h*4`. Gating on length was tried in round-4 to
 * avoid false positives on raw RGBA whose first pixel begins with JPEG SOI
 * bytes (e.g. RGB 255/216/255), but it created a silent-misclassification
 * path: an encoded PNG or JPEG whose compressed size coincidentally equals
 * `w*h*4` would bypass the guard entirely and corrupt Sobel/color output.
 *
 * False-positive risk with the unconditional sniff is negligible:
 *  - PNG: requires all 8 bytes `89 50 4E 47 0D 0A 1A 0A` to match, which
 *    raw RGBA pixels cannot replicate in practice.
 *  - JPEG: requires 4 bytes `FF D8 FF [C0-FE]` where the marker byte covers
 *    the full valid JPEG marker range (SOF, DHT, DAC, DQT, COM, APP*, etc.).
 *    The 4th byte 0xFF is excluded (it is the JPEG stuff byte / padding, not
 *    a real marker), so a raw RGBA pixel with alpha=0xFF does not fire.
 */
function assertNotEncodedImage(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  fnName: string,
): void {
  // Full 8-byte PNG signature — always check, regardless of buffer length.
  if (rgba.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => rgba[i] === b)) {
    throw new Error(
      `${fnName}: received encoded PNG buffer instead of raw RGBA bytes ` +
        `(length must equal width*height*4). Decode first, e.g.: ` +
        `sharp(buffer).raw().toBuffer({ resolveWithObject: true })`,
    );
  }
  // JPEG SOI (FF D8 FF) + the 4th byte must be a valid JPEG marker byte in
  // the range [C0-FE]. This covers all real JPEG segment markers (SOF0-SOF15,
  // DHT, DAC, RST0-RST7, SOI, APP0-APP15, COM, DQT, DNL, DRI, DHP, EXP,
  // SOS, EOI). The value 0xFF is the JPEG stuff/padding byte, NOT a marker,
  // so alpha=0xFF in a raw RGBA pixel does not trigger a false positive.
  if (
    rgba.length >= 4 &&
    JPEG_SOI.every((b, i) => rgba[i] === b) &&
    rgba[3] >= 0xc0 &&
    rgba[3] <= 0xfe
  ) {
    throw new Error(
      `${fnName}: received encoded JPEG buffer instead of raw RGBA bytes ` +
        `(length must equal width*height*4). Decode first, e.g.: ` +
        `sharp(buffer).raw().toBuffer({ resolveWithObject: true })`,
    );
  }
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Default Sobel gradient magnitude threshold per #710 v2. */
export const DEFAULT_EDGE_GRADIENT_THRESHOLD = 30;

/** Default sRGB color-match tolerance per #710 v2. */
export const DEFAULT_COLOR_BG_TOLERANCE = 30;

/** Default edge-density threshold for "pixel_absent" verdict. */
export const DEFAULT_PIXEL_ABSENT_EDGE_DENSITY = 0.02;

function clampInt(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return Math.floor(v);
}

/** Floor-clamp for region start coordinates (include only fully-contained start). */
function clampStart(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

/** Ceil-clamp for region end coordinates (include any partially-touched pixel). */
function clampEnd(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.ceil(v)));
}

/** Rec. 601 luma — fast and good enough for edge detection. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Index into an RGBA buffer at (x, y), returning {r, g, b}. Out-of-
 * bounds requests are clamped to the nearest in-bounds pixel — that's
 * the standard Sobel boundary policy.
 */
export function pixelRgb(rgba: Uint8Array | Buffer, w: number, h: number, x: number, y: number): RgbColor {
  const cx = clampInt(x, 0, w - 1);
  const cy = clampInt(y, 0, h - 1);
  const i = (cy * w + cx) * 4;
  return { r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] };
}

/**
 * Compute edge density on a crop of an RGBA buffer.
 *
 * `edge_density = high_gradient_pixels / total_pixels`.
 * `high-gradient` iff |∇I_x| + |∇I_y| > threshold (the L1 form is
 * sufficient and cheaper than the L2 magnitude — same threshold range).
 *
 * Boundary policy: clamp-to-edge (standard for Sobel).
 *
 * **Contract:** `rgba` must be raw RGBA bytes — 4 bytes per pixel,
 * `length === width * height * 4`. Passing an encoded PNG or JPEG buffer
 * (e.g., from `Page.screenshot()` default output) throws a descriptive
 * error. Decode first with e.g. `sharp(buffer).raw().toBuffer(...)`.
 */
export function sobelEdgeDensity(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  crop: CropRect,
  threshold: number = DEFAULT_EDGE_GRADIENT_THRESHOLD,
): number {
  assertNotEncodedImage(rgba, width, height, 'sobelEdgeDensity');
  if (rgba.length !== width * height * 4) {
    throw new Error(`sobelEdgeDensity: buffer length ${rgba.length} != ${width * height * 4}`);
  }
  if (
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.w) ||
    !Number.isFinite(crop.h)
  ) {
    return 0;
  }
  const x0 = clampStart(crop.x, 0, width);
  const y0 = clampStart(crop.y, 0, height);
  const x1 = clampEnd(crop.x + crop.w, 0, width);
  const y1 = clampEnd(crop.y + crop.h, 0, height);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return 0;

  let highGradient = 0;
  // 3x3 Sobel kernels:
  //   Gx = [-1 0 1; -2 0 2; -1 0 1]
  //   Gy = [-1 -2 -1; 0 0 0; 1 2 1]
  //
  // Hot-loop optimisation: read channel bytes directly via base-index
  // arithmetic instead of calling luma(...rgbAt(...)), which allocated a
  // fresh [r,g,b] tuple on every call (8 allocations per sampled pixel).
  // On full-page crops this produced millions of short-lived objects per
  // element, dominating runtime with GC pressure. The Rec.601 luma
  // formula is identical; luma/rgbAt remain exported for external callers.
  const lumaAt = (px: number, py: number): number => {
    const cx = clampInt(px, 0, width - 1);
    const cy = clampInt(py, 0, height - 1);
    const base = (cy * width + cx) * 4;
    return 0.299 * rgba[base] + 0.587 * rgba[base + 1] + 0.114 * rgba[base + 2];
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const tl = lumaAt(x - 1, y - 1);
      const tm = lumaAt(x, y - 1);
      const tr = lumaAt(x + 1, y - 1);
      const ml = lumaAt(x - 1, y);
      const mr = lumaAt(x + 1, y);
      const bl = lumaAt(x - 1, y + 1);
      const bm = lumaAt(x, y + 1);
      const br = lumaAt(x + 1, y + 1);
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tm - tr + bl + 2 * bm + br;
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag > threshold) highGradient++;
    }
  }
  return highGradient / (cw * ch);
}

/** Inline tuple form so `luma(...rgbAt(...))` stays a single allocation. */
export function rgbAt(
  rgba: Uint8Array | Buffer,
  w: number,
  h: number,
  x: number,
  y: number,
): [number, number, number] {
  const cx = clampInt(x, 0, w - 1);
  const cy = clampInt(y, 0, h - 1);
  const i = (cy * w + cx) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2]];
}

/**
 * sRGB Euclidean color distance over 0-255 components.
 *   d = sqrt(dR² + dG² + dB²); range 0 (identical) … ~441 (black↔white)
 */
export function colorDistance(a: RgbColor, b: RgbColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Approximate the dominant color of an arbitrary RGBA region by
 * histogram-bucketed mode. Buckets are 16×16×16 (4 KB), good enough
 * for "what color is this background" — full k-means would be
 * dependency-rich for sub-1 % accuracy gain.
 *
 * Returns `null` when the region clamps to an empty rectangle (zero
 * width or height after clamping to the image bounds). Callers must
 * treat `null` as a sentinel meaning "no pixels were sampled" and
 * propagate it as a flagged mismatch, not as a real color.
 *
 * **Contract:** `rgba` must be raw RGBA bytes — 4 bytes per pixel,
 * `length === width * height * 4`. Passing an encoded PNG or JPEG buffer
 * (e.g., from `Page.screenshot()` default output) throws a descriptive
 * error. Decode first with e.g. `sharp(buffer).raw().toBuffer(...)`.
 */
export function dominantColor(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  region?: CropRect,
): RgbColor | null {
  assertNotEncodedImage(rgba, width, height, 'dominantColor');
  if (rgba.length !== width * height * 4) {
    throw new Error(`dominantColor: buffer length ${rgba.length} != ${width * height * 4}`);
  }
  if (
    region !== undefined &&
    (!Number.isFinite(region.x) ||
      !Number.isFinite(region.y) ||
      !Number.isFinite(region.w) ||
      !Number.isFinite(region.h))
  ) {
    return null;
  }
  const x0 = region ? clampStart(region.x, 0, width) : 0;
  const y0 = region ? clampStart(region.y, 0, height) : 0;
  const x1 = region ? clampEnd(region.x + region.w, 0, width) : width;
  const y1 = region ? clampEnd(region.y + region.h, 0, height) : height;
  if (x1 <= x0 || y1 <= y0) return null;
  const buckets = new Uint32Array(16 * 16 * 16);
  let bestCount = 0;
  let bestKey = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i] >> 4;
      const g = rgba[i + 1] >> 4;
      const b = rgba[i + 2] >> 4;
      const k = (r << 8) | (g << 4) | b;
      const c = (buckets[k] += 1);
      if (c > bestCount) {
        bestCount = c;
        bestKey = k;
      }
    }
  }
  return {
    r: ((bestKey >> 8) & 0xf) << 4,
    g: ((bestKey >> 4) & 0xf) << 4,
    b: (bestKey & 0xf) << 4,
  };
}
