/**
 * Best-effort trace emission for the resumable crawl tools (issue #886).
 *
 * Uses the existing JSONL trace storage (`src/core/trace`). Each MCP session
 * is mapped to a single trace session keyed by `crawl-jobs:<sessionId>` so
 * that all `crawl_start` / `crawl_status` / `crawl_cancel` events from the
 * same caller land in one trace file.
 *
 * Failures are swallowed — trace emission is observability, never a hard
 * dependency of tool behavior.
 */

import { TraceStorage } from '../trace';
import type { TraceEvent } from '../trace';

const TRACE_SESSION_PREFIX = 'crawl-jobs-';
const startedSessions = new Set<string>();
const seqCounters = new Map<string, number>();

function traceSessionId(sessionId: string): string {
  // Trace storage rejects ids with separators or leading dots; collapse the
  // caller's id into a safe basename.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
  return `${TRACE_SESSION_PREFIX}${safe || 'anon'}`;
}

let storageOverride: TraceStorage | undefined;

/** Override the storage backend (used by tests). */
export function _setTraceStorageForTests(storage: TraceStorage | undefined): void {
  storageOverride = storage;
  startedSessions.clear();
  seqCounters.clear();
}

function getStorage(): TraceStorage {
  return storageOverride ?? new TraceStorage();
}

export async function emitCrawlTrace(
  sessionId: string,
  kind: 'crawl_start' | 'crawl_status' | 'crawl_cancel',
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const storage = getStorage();
    const traceSid = traceSessionId(sessionId);
    if (!startedSessions.has(traceSid)) {
      await storage.recordSessionStart({
        sessionId: traceSid,
        startedAt: Date.now(),
        status: 'running',
        parentOp: 'crawl_jobs',
      });
      startedSessions.add(traceSid);
    }
    const seq = (seqCounters.get(traceSid) ?? 0) + 1;
    seqCounters.set(traceSid, seq);
    const event: TraceEvent = { ts: Date.now(), seq, kind, body };
    await storage.appendEvents(traceSid, [event]);
  } catch {
    // Best-effort: trace failures must not propagate into the tool result.
  }
}
