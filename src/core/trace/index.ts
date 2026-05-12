/**
 * Barrel export for `src/core/trace/`.
 *
 * Public surface for the JSONL-backed trace storage layer plus the
 * credential redactor that runs before events hit disk.
 */

export { REDACTED, redactTraceEvent, redactValue, scrubString } from './redactor';
export {
  TraceStorage,
  defaultTraceRootDir,
  type AppendResult,
  type TraceStorageOptions,
} from './storage';
export type {
  TraceEvent,
  TraceListFilter,
  TraceSessionMeta,
  TraceStatus,
} from './types';
