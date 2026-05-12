/**
 * Barrel export for the JSON-per-domain skill graph storage subsystem.
 *
 * The persisted schema and counter semantics are preserved verbatim from
 * closed PR #738 v2; only the backend (SQLite → JSON + `proper-lockfile`)
 * changed, per the portability-harness contract clause P5.
 */

export {
  SkillGraphStorage,
  defaultSkillGraphRootDir,
} from './storage';
export type {
  RecordEdgeInput,
  SkillGraphStorageOptions,
} from './storage';
export type {
  EdgeKey,
  PersistedEdge,
  PersistedNode,
  SkillEdge,
  SkillGraphFile,
  SkillGraphInspectSummary,
  SkillNode,
  ToStateDistribution,
} from './types';
