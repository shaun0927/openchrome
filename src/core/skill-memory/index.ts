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

export {
  SKILL_MEMORY_SCHEMA_VERSION,
  SKILL_MEMORY_SCHEMA_VERSION_V1,
} from './types';
export type {
  FrozenSnapshot,
  SkillMemoryFile,
  SkillMemoryFileV1,
  SkillRecord,
} from './types';

export {
  REPLAY_ARTIFACT_SCHEMA_VERSION,
  REPLAY_SELECTOR_TYPES,
  REPLAY_STEP_KINDS,
  replayArtifactJsonSchema,
  validateReplayArtifact,
  validateReplayArtifactStep,
  validateReplaySelector,
} from './replay-artifact';
export type {
  ReplayArtifact,
  ReplayArtifactStep,
  ReplaySelector,
  ReplaySelectorType,
  ReplayStepKind,
  ValidationResult,
} from './replay-artifact';

export {
  MAX_STEPS_PER_TARGET,
  bufferSize as recorderBufferSize,
  capture as captureReplayStep,
  flush as flushRecorderBuffer,
  peek as peekRecorderBuffer,
  resetAll as resetRecorderBuffers,
} from './recorder-buffer';
