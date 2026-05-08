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
  dominantColor,
  sobelEdgeDensity,
  type CropRect,
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
  const edgeGradientThreshold =
    opts.edgeGradientThreshold ??
    envFloat('OPENCHROME_CROSS_CHECK_EDGE_THRESHOLD', DEFAULT_EDGE_GRADIENT_THRESHOLD);
  const edgeDensityThreshold =
    opts.edgeDensityThreshold ??
    envFloat('OPENCHROME_CROSS_CHECK_EDGE_DENSITY', DEFAULT_PIXEL_ABSENT_EDGE_DENSITY);
  const colorTolerance =
    opts.colorTolerance ??
    envFloat('OPENCHROME_CROSS_CHECK_COLOR_TOLERANCE', DEFAULT_COLOR_BG_TOLERANCE);

  const edgeDensity = sobelEdgeDensity(rgba, width, height, crop, edgeGradientThreshold);
  const dom = dominantColor(rgba, width, height, crop);

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

  const dist = colorDistance(dom, opts.backgroundColor);

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
