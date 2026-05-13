/**
 * Public re-exports for the task ledger module. Callers should import
 * from `src/core/task-ledger` rather than from individual files.
 */

export type {
  TaskEvent,
  TaskKind,
  TaskListFilter,
  TaskMeta,
  TaskOwner,
  TaskStatus,
} from './types';
export {
  TaskStore,
  computeTaskId,
  defaultTaskRootDir,
  summariseArgs,
  isPidAlive,
  assertSafeTaskId,
} from './store';
export type { TaskStoreOptions } from './store';
export type {
  BuildTaskEvidenceDigestOptions,
  TaskEvidenceCategory,
  TaskEvidenceDigest,
  TaskEvidenceDigestEvent,
} from './digest';
export {
  buildTaskEvidenceDigest,
  digestFromParts,
} from './digest';
export type { RunInput, RunOutcome } from './runner';
export {
  runTask,
  waitForTerminal,
  TaskWaitTimeoutError,
} from './runner';
