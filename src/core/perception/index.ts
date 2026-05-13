/**
 * Adversarial-Robust Perception barrel (#700). PR-16 ships the
 * metadata classifier + cache; PR-17 will add cross-check + image
 * features; PR-18 wires the pre-action hook; PR-19 adds multi-model
 * voting.
 */

export { computePerceptualMetadata, effectiveOpacity, intersects } from './metadata';
export { PerceptualCache } from './cache';
export {
  SnapshotCache,
  SNAPSHOT_CACHE_DEFAULT_MAX_ENTRIES,
  SNAPSHOT_CACHE_DEFAULT_TTL_MS,
  getSnapshotCacheForTarget,
  disposeSnapshotCacheForTarget,
  resetSnapshotCacheRegistry,
} from './snapshot-cache';
export type {
  SnapshotKind,
  SnapshotCacheKey,
  SnapshotCacheHit,
  SnapshotCacheStats,
  SnapshotViewportRect,
  EvictReason,
} from './snapshot-cache';
export {
  paramsHash,
  paramsHashFromArgs,
  READ_PAGE_PARAMS,
  FIND_PARAMS,
  QUERY_DOM_PARAMS,
} from './params-hash';
export {
  InMemoryBackendNodeRegistry,
  getBackendNodeRegistry,
  _resetBackendNodeRegistryForTests,
} from './backend-node-registry';
export type { BackendNodeRegistry, StableUid } from './backend-node-registry';
export {
  NODE_REF_OFF,
  formatNodeRefToken,
  formatUidEvictedError,
  getCurrentLoaderId,
  isNodeRefEnabled,
  mintNodeRef,
  mintNodeRefSync,
  resolveNodeRef,
} from './node-ref';
export type { CdpSendShape } from './node-ref';
export type {
  EffectiveDisplay,
  InteractionFeasibility,
  NodeProbe,
  PerceptualMetadata,
  PixelBox,
  ViewportRect,
} from './types';
