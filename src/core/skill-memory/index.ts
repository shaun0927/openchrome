/**
 * Core skill memory barrel (#712 epic, Phase 3 cleanup).
 *
 * Exposes only the storage primitive — the recall ranking layer is
 * pilot-tier work and lives under `src/pilot/**`.
 */

export {
  SkillMemoryStore,
  defaultSkillMemoryRootDir,
} from './store';
export type {
  ListFilter,
  RecordResult,
  SkillMemoryStoreOptions,
  WriteFrozenSnapshotResult,
} from './store';

export { SKILL_MEMORY_SCHEMA_VERSION } from './types';
export type { FrozenSnapshot, SkillMemoryFile, SkillRecord } from './types';
