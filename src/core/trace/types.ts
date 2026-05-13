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

/**
 * Trace target envelope — recorded under `args.target` of a tool-call event
 * by recorders that capture the backend-node uid contract (#844).
 *
 * The three keys are non-sensitive (no PII, no credentials) but the trace
 * redactor's allow-list is updated explicitly in `redactor.ts` so the
 * "non-redaction" decision is a deliberate rather than incidental property.
 */
export interface TraceTarget {
  /** Stable uid issued by `BackendNodeRegistry`. `null` when the feature
   * flag is off (`OPENCHROME_NODE_REF=0`). */
  nodeRef: string | null;
  /** CDP backendNodeId resolved at action time. */
  backendNodeId: number;
  /** CDP loaderId in effect when the action was issued. */
  loaderId: string;
}

/**
 * Helper for recorders that need to construct a `TraceTarget`. Validates
 * input shape so a malformed target never silently lands on disk.
 */
export function makeTraceTarget(
  nodeRef: string | null,
  backendNodeId: number,
  loaderId: string,
): TraceTarget {
  if (nodeRef !== null && (typeof nodeRef !== 'string' || nodeRef.length === 0)) {
    throw new TypeError(
      'makeTraceTarget: nodeRef must be a non-empty string or null',
    );
  }
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    throw new TypeError(
      `makeTraceTarget: backendNodeId must be a positive integer (got ${backendNodeId})`,
    );
  }
  if (typeof loaderId !== 'string' || loaderId.length === 0) {
    throw new TypeError('makeTraceTarget: loaderId must be a non-empty string');
  }
  return { nodeRef, backendNodeId, loaderId };
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
