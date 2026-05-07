/**
 * Skill subsystem barrel — state hashing, URL normalization, interactive
 * filter. Future PRs add storage (#702) and executor (#703).
 */

export { normalizeUrl, TRACKING_PARAM_PATTERNS } from './url-normalizer';
export type { NormalizeUrlResult } from './url-normalizer';

export { isInteractiveNode } from './interactive-filter';
export type { InteractiveProbe } from './interactive-filter';

export { computeStateHash, canonicalJson } from './state';
export type {
  PageSnapshot,
  LandmarkFlags,
  StateHashEvidence,
  StateHashResult,
} from './state';

export { SkillGraphStorage, defaultSkillGraphRootDir } from './storage';
export type {
  SkillNode,
  SkillEdge,
  ToStateDistribution,
  SkillGraphInspectSummary,
  SkillGraphStorageOptions,
} from './storage';

export { runSkill, pickBestEdge, matchesExpected } from './executor';
export type {
  ActionInvocation,
  ActionResult,
  ExecutionContext,
  ToolRouter,
  SkillIntent,
  RunSkillResult,
  RunSkillArgs,
  RunOutcomeKind,
} from './executor';

export {
  AuditLogGraphEmitter,
  buildEventFromResult,
  emitGraphEvent,
} from './audit';
export type { GraphAuditEvent, GraphAuditEventKind, GraphAuditEmitter } from './audit';
