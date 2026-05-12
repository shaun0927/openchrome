/**
 * Common types for the trace recorder, storage, and replay subsystems.
 *
 * These are deliberately small and JSON-serialisable so trace files can be
 * read back without depending on the runtime types.
 */

/** Terminal status of a recorded trace session. */
export type TraceStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** Per-session metadata persisted alongside the JSONL event files. */
export interface TraceSessionMeta {
  sessionId: string;
  startedAt: number; // unix epoch ms
  endedAt?: number;
  /** eTLD+1 host of the dominant origin in the session, if known. */
  domain?: string;
  status: TraceStatus;
  /** Bytes consumed on disk by this session's JSONL files. */
  byteSize: number;
  /** Optional label for the parent operation (e.g. tool name, skill id). */
  parentOp?: string;
}

/** A single event captured during recording. */
export interface TraceEvent {
  /** unix epoch ms */
  ts: number;
  /** monotonic per-session sequence number */
  seq: number;
  /** CDP method, or a synthetic kind such as `screenshot` / `tool_call`. */
  kind: string;
  body: unknown;
}

/** Filter shape for `TraceStorage.list`. */
export interface TraceListFilter {
  /** Only sessions started >= this ms epoch. */
  since?: number;
  /** Only sessions with one of these statuses. */
  status?: TraceStatus | TraceStatus[];
  /** Exact domain match. */
  domain?: string;
  /** Maximum rows to return (defaults to 100). */
  limit?: number;
}
