/**
 * DOM ↔ screenshot cross-check (#710 v2).
 *
 * Given (a) a target element's `pixelBox` from the perceptual metadata
 * (#709) and (b) a recent screenshot, decide whether the element is
 * actually visible to the human eye. Cloaked / honeypot elements pass
 * the DOM presence check but vanish into a same-color background.
 *
 * Decision rule per #710 v2:
 *   - If `edge_density < edgeDensityThreshold` (default 0.02)
 *     AND the cropped region's dominant color is within `colorTolerance`
 *     of the page's background color
 *   ⇒ verdict `pixel_absent` (a likely cloak)
 *
 *   - Otherwise verdict `consistent` (DOM and pixels agree)
 *
 * Both thresholds are overridable per call (or via env). Tests pass
 * synthetic RGBA buffers directly — no real screenshot needed.
 */

import {
  DEFAULT_COLOR_BG_TOLERANCE,
  DEFAULT_EDGE_GRADIENT_THRESHOLD,
  DEFAULT_PIXEL_ABSENT_EDGE_DENSITY,
  colorDistance,
  decodePngToRgba,
  dominantColor,
  isPngBuffer,
  sobelEdgeDensity,
  type CropRect,
  type DecodedRgbaImage,
  type RgbColor,
} from './image-features';

export type CrossCheckVerdict = 'consistent' | 'pixel_absent' | 'empty_region';

export interface CrossCheckResult {
  verdict: CrossCheckVerdict;
  edge_density: number;
  /** `null` when the crop clamped to an empty rectangle (verdict is `empty_region`). */
  dominant_color: RgbColor | null;
  background_color: RgbColor;
  color_distance: number;
  /** Reasons the verdict was reached, for hint-engine evidence. */
  reasons: string[];
}

export interface CrossCheckOptions {
  /** Sobel gradient magnitude cutoff. */
  edgeGradientThreshold?: number;
  /** Edge-density (high_grad / area) cutoff for `pixel_absent`. */
  edgeDensityThreshold?: number;
  /** sRGB Euclidean tolerance for "matches background". */
  colorTolerance?: number;
  /**
   * Pre-computed page background color. Hosts derive this once per
   * page (e.g., dominant color of the four corners) and pass it on
   * each cross-check call.
   */
  backgroundColor: RgbColor;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const _warnedOverrides = new Set<string>();

/**
 * Validate a per-call threshold override.
 * Returns `value` only when it is a finite, non-negative number; otherwise
 * emits a one-shot console.error warning and returns `fallback`.
 */
function coerceFiniteNonNegative(key: string, value: number, fallback: number): number {
  if (Number.isFinite(value) && value >= 0) return value;
  if (!_warnedOverrides.has(key)) {
    _warnedOverrides.add(key);
    console.error(
      `[cross-check] runCrossCheck: override "${key}" value ${value} is not a finite non-negative number; ` +
        `using fallback ${fallback}.`,
    );
  }
  return fallback;
}

/**
 * Run cross-check on a single element pixelBox.
 *
 * @param rgba    The full screenshot buffer (RGBA).
 * @param width   Screenshot width in pixels.
 * @param height  Screenshot height in pixels.
 * @param crop    The element's pixelBox in screenshot coordinates.
 * @param opts    Threshold overrides + the page's background color.
 */
export function runCrossCheck(
  rgba: Uint8Array | Buffer,
  width: number,
  height: number,
  crop: CropRect,
  opts: CrossCheckOptions,
): CrossCheckResult {
  const edgeGradientThresholdDefault = envFloat(
    'OPENCHROME_CROSS_CHECK_EDGE_THRESHOLD',
    DEFAULT_EDGE_GRADIENT_THRESHOLD,
  );
  const edgeGradientThreshold =
    opts.edgeGradientThreshold !== undefined
      ? coerceFiniteNonNegative('edgeGradientThreshold', opts.edgeGradientThreshold, edgeGradientThresholdDefault)
      : edgeGradientThresholdDefault;

  const edgeDensityThresholdDefault = envFloat(
    'OPENCHROME_CROSS_CHECK_EDGE_DENSITY',
    DEFAULT_PIXEL_ABSENT_EDGE_DENSITY,
  );
  const edgeDensityThreshold =
    opts.edgeDensityThreshold !== undefined
      ? coerceFiniteNonNegative('edgeDensityThreshold', opts.edgeDensityThreshold, edgeDensityThresholdDefault)
      : edgeDensityThresholdDefault;

  const colorToleranceDefault = envFloat('OPENCHROME_CROSS_CHECK_COLOR_TOLERANCE', DEFAULT_COLOR_BG_TOLERANCE);
  const colorTolerance =
    opts.colorTolerance !== undefined
      ? coerceFiniteNonNegative('colorTolerance', opts.colorTolerance, colorToleranceDefault)
      : colorToleranceDefault;

  let image = rgba;
  let imageWidth = width;
  let imageHeight = height;
  if (isPngBuffer(rgba)) {
    const decoded = decodePngToRgba(rgba);
    image = decoded.rgba;
    imageWidth = decoded.width;
    imageHeight = decoded.height;
  }

  const edgeDensity = sobelEdgeDensity(image, imageWidth, imageHeight, crop, edgeGradientThreshold);
  const dom = dominantColor(image, imageWidth, imageHeight, crop);

  // Empty-region guard: pixelBox clamped to zero area — no pixels were
  // sampled. This is a definitive mismatch (the element has no visible
  // pixels), not a color match against black.
  if (dom === null) {
    return {
      verdict: 'empty_region',
      edge_density: edgeDensity,
      dominant_color: null,
      background_color: opts.backgroundColor,
      color_distance: 0,
      reasons: ['crop clamped to empty rectangle — no pixels sampled'],
    };
  }

  // Validate backgroundColor channels are finite numbers in [0, 255].
  // A non-finite channel (NaN / Infinity) makes colorDistance return a
  // non-finite value whose comparison with colorTolerance is always false,
  // silently keeping verdict='consistent' even for low-edge, background-
  // matching crops (fail-open). Treat invalid backgroundColor as a
  // non-consistent result (fail-closed).
  const bg = opts.backgroundColor;
  if (
    !Number.isFinite(bg.r) ||
    !Number.isFinite(bg.g) ||
    !Number.isFinite(bg.b) ||
    bg.r < 0 ||
    bg.r > 255 ||
    bg.g < 0 ||
    bg.g > 255 ||
    bg.b < 0 ||
    bg.b > 255
  ) {
    console.error(
      `[cross-check] runCrossCheck: backgroundColor has non-finite or out-of-range channel ` +
        `(r=${bg.r}, g=${bg.g}, b=${bg.b}); cannot compute color distance — returning mismatch verdict.`,
    );
    return {
      verdict: 'pixel_absent',
      edge_density: edgeDensity,
      dominant_color: dom,
      background_color: bg,
      color_distance: NaN,
      reasons: ['backgroundColor has non-finite or out-of-range channel — fail-closed mismatch'],
    };
  }

  const dist = colorDistance(dom, bg);

  const reasons: string[] = [];
  let verdict: CrossCheckVerdict = 'consistent';

  if (edgeDensity < edgeDensityThreshold) {
    reasons.push(`edge_density ${edgeDensity.toFixed(4)} < ${edgeDensityThreshold}`);
    if (dist <= colorTolerance) {
      reasons.push(`color_distance ${dist.toFixed(2)} ≤ ${colorTolerance}`);
      verdict = 'pixel_absent';
    } else {
      reasons.push(`color_distance ${dist.toFixed(2)} > ${colorTolerance} (background mismatch)`);
    }
  } else {
    reasons.push(`edge_density ${edgeDensity.toFixed(4)} ≥ ${edgeDensityThreshold}`);
  }

  return {
    verdict,
    edge_density: edgeDensity,
    dominant_color: dom,
    background_color: opts.backgroundColor,
    color_distance: dist,
    reasons,
  };
}

/**
 * Decode a PNG screenshot once, then run cross-check on every annotation.
 *
 * Use this instead of calling `runCrossCheck` per element when the same
 * screenshot is checked against multiple crops. `runCrossCheck` decodes the
 * PNG on every call (`O(elements × pixels)` of zlib work); this function
 * decodes once and reuses the resulting RGBA buffer for all crops.
 *
 * @param image       The full screenshot — either a raw RGBA `Buffer` or an
 *                    encoded PNG `Buffer`. PNGs are decoded exactly once.
 * @param width       Screenshot width (ignored when `image` is a PNG; derived
 *                    from the PNG IHDR instead).
 * @param height      Screenshot height (same caveat).
 * @param crops       Array of element pixelBoxes to cross-check.
 * @param opts        Threshold overrides + page background color (applied to
 *                    every element uniformly).
 * @returns           One `CrossCheckResult` per element, in the same order as
 *                    `crops`.
 */
export function runCrossCheckBatch(
  image: Uint8Array | Buffer,
  width: number,
  height: number,
  crops: CropRect[],
  opts: CrossCheckOptions,
): CrossCheckResult[] {
  let rgba: Uint8Array | Buffer;
  let w: number;
  let h: number;

  if (isPngBuffer(image)) {
    const decoded: DecodedRgbaImage = decodePngToRgba(image);
    rgba = decoded.rgba;
    w = decoded.width;
    h = decoded.height;
  } else {
    rgba = image;
    w = width;
    h = height;
  }

  return crops.map((crop) => runCrossCheck(rgba, w, h, crop, opts));
}
