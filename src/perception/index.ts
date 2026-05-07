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
  sobelEdgeDensity,
} from './image-features';
export type { CropRect, RgbColor } from './image-features';

export { runCrossCheck } from './cross-check';
export type {
  CrossCheckOptions,
  CrossCheckResult,
  CrossCheckVerdict,
} from './cross-check';

export {
  COORDINATE_TOLERANCE_PX,
  SCROLL_TOLERANCE_PX,
  VotingOrchestrator,
  VotingSessionBudget,
  actionsEquivalent,
  extractFirstJsonObject,
} from './voting';
export type {
  ActionInvocation,
  EquivalenceContext,
  ProviderError,
  ProviderErrorKind,
  ProviderReply,
  VoteRequest,
  VoteVerdict,
  VotingDisagreement,
  VotingOrchestratorOptions,
  VotingPolicy,
  VotingProvider,
} from './voting';
