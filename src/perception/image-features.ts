/**
 * Image feature primitives for the cross-check module (#710 v2).
 *
 * Pure JS, dependency-free — no sharp, no native bindings. Inputs are
 * tightly-packed RGBA byte buffers (4 bytes per pixel) which is the
 * format puppeteer's `Page.screenshot()` produces by default.
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

/** Rec. 601 luma — fast and good enough for edge detection. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Index into an RGBA buffer at (x, y), returning {r, g, b}. Out-of-
 * bounds requests are clamped to the nearest in-bounds pixel — that's
 * the standard Sobel boundary policy.
 */
function pixelRgb(rgba: Uint8Array | Buffer, w: number, h: number, x: number, y: number): RgbColor {
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
 */
export function sobelEdgeDensity(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  crop: CropRect,
  threshold: number = DEFAULT_EDGE_GRADIENT_THRESHOLD,
): number {
  if (rgba.length !== width * height * 4) {
    throw new Error(`sobelEdgeDensity: buffer length ${rgba.length} != ${width * height * 4}`);
  }
  const x0 = clampInt(crop.x, 0, width);
  const y0 = clampInt(crop.y, 0, height);
  const x1 = clampInt(crop.x + crop.w, 0, width);
  const y1 = clampInt(crop.y + crop.h, 0, height);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return 0;

  let highGradient = 0;
  // 3x3 Sobel kernels:
  //   Gx = [-1 0 1; -2 0 2; -1 0 1]
  //   Gy = [-1 -2 -1; 0 0 0; 1 2 1]
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const tl = luma(...rgbAt(rgba, width, height, x - 1, y - 1));
      const tm = luma(...rgbAt(rgba, width, height, x, y - 1));
      const tr = luma(...rgbAt(rgba, width, height, x + 1, y - 1));
      const ml = luma(...rgbAt(rgba, width, height, x - 1, y));
      const mr = luma(...rgbAt(rgba, width, height, x + 1, y));
      const bl = luma(...rgbAt(rgba, width, height, x - 1, y + 1));
      const bm = luma(...rgbAt(rgba, width, height, x, y + 1));
      const br = luma(...rgbAt(rgba, width, height, x + 1, y + 1));
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tm - tr + bl + 2 * bm + br;
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag > threshold) highGradient++;
    }
  }
  return highGradient / (cw * ch);
}

/** Inline tuple form so `luma(...rgbAt(...))` stays a single allocation. */
function rgbAt(
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
 */
export function dominantColor(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  region?: CropRect,
): RgbColor | null {
  const x0 = region ? clampInt(region.x, 0, width) : 0;
  const y0 = region ? clampInt(region.y, 0, height) : 0;
  const x1 = region ? clampInt(region.x + region.w, 0, width) : width;
  const y1 = region ? clampInt(region.y + region.h, 0, height) : height;
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
