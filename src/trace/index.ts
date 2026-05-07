/**
 * Trace subsystem public surface.
 *
 * Consumers (recorder, replay UI, tests) should import from this barrel
 * rather than reaching into individual files — the internal layout may
 * shift as the recorder (PR-2) is wired in.
 */

export { TraceStorage, defaultTraceRootDir } from './storage';
export type { AppendResult, TraceStorageOptions } from './storage';

export {
  TraceRecorder,
  getTraceRecorder,
  DEFAULT_TRACE_KINDS,
  _resetTraceRecorderForTests,
} from './recorder';
export type {
  EventEmitterLike,
  PageLike,
  TraceRecorderOptions,
} from './recorder';

export { redactTraceEvent, redactValue, scrubString, REDACTED } from './redactor';

export type {
  TraceEvent,
  TraceListFilter,
  TraceSessionMeta,
  TraceStatus,
} from './types';
