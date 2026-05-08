/**
 * Adversarial-Robust Perception barrel (#700). PR-16 ships the
 * metadata classifier + cache; PR-17 will add cross-check + image
 * features; PR-18 wires the pre-action hook; PR-19 adds multi-model
 * voting.
 */

export { computePerceptualMetadata, effectiveOpacity, intersects } from './metadata';
export { PerceptualCache } from './cache';
export type {
  EffectiveDisplay,
  InteractionFeasibility,
  NodeProbe,
  PerceptualMetadata,
  PixelBox,
  ViewportRect,
} from './types';

export {
  DEFAULT_COLOR_BG_TOLERANCE,
  DEFAULT_EDGE_GRADIENT_THRESHOLD,
  DEFAULT_PIXEL_ABSENT_EDGE_DENSITY,
  colorDistance,
  dominantColor,
  isPngBuffer,
  sobelEdgeDensity,
} from './image-features';
export type { CropRect, DecodedRgbaImage, RgbColor } from './image-features';

export { runCrossCheck, runCrossCheckBatch } from './cross-check';
export type {
  CrossCheckOptions,
  CrossCheckResult,
  CrossCheckVerdict,
} from './cross-check';
