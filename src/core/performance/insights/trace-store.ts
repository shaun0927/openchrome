/**
 * Performance trace handle store (#846).
 *
 * `oc_performance_insights` writes a CDP trace to disk and returns a
 * `trace_id` handle. `oc_performance_analyze` reads that trace back by
 * handle. Handles are scoped to a SessionManager session; on session
 * close (`session:deleted`) every handle owned by the session is
 * invalidated and the underlying file is deleted.
 *
 * Files live under `path.join(os.homedir(), '.openchrome', 'perf-traces')`
 * (per CLAUDE.md: never `process.env.HOME`). Each trace is gzip-encoded
 * JSONL where every line is one trace event — this matches the layout
 * the trace recorder already uses (see `src/core/trace/storage.ts`) and
 * keeps the on-disk footprint small for the typical multi-megabyte
 * Tracing.dataCollected stream.
 *
 * The store does not poll the SessionManager; tools subscribe to its
 * event listener once on first use. This mirrors the cleanup pattern
 * that `console-capture.ts` uses for per-tab CDP sessions.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TraceDocument, TraceEventRecord } from './types';

export interface PerfTraceHandle {
  trace_id: string;
  session_id: string;
  trace_path: string;
  created_at: number;
  byte_size: number;
}

export interface PerfTraceStoreOptions {
  /** Override root dir (tests). Defaults to `~/.openchrome/perf-traces`. */
  rootDir?: string;
}

export function defaultPerfTraceRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'perf-traces');
}

/**
 * Per-trace on-disk filename. The `trace_id` is a UUID and is therefore
 * already filesystem-safe; we still constrain to the literal v4 hyphen
 * shape so a malicious caller cannot inject a path component.
 */
const TRACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSafeTraceId(id: string): void {
  if (!TRACE_ID_RE.test(id)) {
    throw new Error(`PerfTraceStore: trace_id "${id}" is not a valid UUID`);
  }
}

export class PerfTraceStore {
  private readonly rootDir: string;
  /** trace_id -> handle metadata. */
  private readonly handles = new Map<string, PerfTraceHandle>();
  /** session_id -> Set<trace_id> for fast eviction on session close. */
  private readonly bySession = new Map<string, Set<string>>();
  private rootEnsured = false;

  constructor(opts: PerfTraceStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultPerfTraceRootDir();
  }

  private ensureRoot(): void {
    if (this.rootEnsured) return;
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.rootEnsured = true;
  }

  private filePath(traceId: string): string {
    assertSafeTraceId(traceId);
    return path.join(this.rootDir, `${traceId}.jsonl.gz`);
  }

  /**
   * Persist a trace event stream and register a session-scoped handle.
   * Caller-supplied `metadata` is merged into the JSONL envelope as the
   * first line so analyze() can reconstruct the trace document without a
   * second round trip.
   */
  store(args: {
    sessionId: string;
    events: TraceEventRecord[];
    metadata?: Record<string, unknown>;
  }): PerfTraceHandle {
    if (!args.sessionId) {
      throw new Error('PerfTraceStore.store: sessionId is required');
    }
    this.ensureRoot();
    const traceId = randomUUID();
    const filePath = this.filePath(traceId);
    // Build a JSONL stream: line 0 = metadata envelope, then one event
    // per line. We gzip the whole buffer so the on-disk file is one
    // atomic write (`writeFileSync` is sufficient — no concurrent
    // writers per trace_id).
    const lines: string[] = [];
    lines.push(JSON.stringify({ kind: 'metadata', metadata: args.metadata ?? {} }));
    for (const ev of args.events) {
      lines.push(JSON.stringify(ev));
    }
    const raw = Buffer.from(lines.join('\n') + '\n', 'utf8');
    const compressed = gzipSync(raw);
    fs.writeFileSync(filePath, compressed);
    const handle: PerfTraceHandle = {
      trace_id: traceId,
      session_id: args.sessionId,
      trace_path: filePath,
      created_at: Date.now(),
      byte_size: compressed.byteLength,
    };
    this.handles.set(traceId, handle);
    let owned = this.bySession.get(args.sessionId);
    if (!owned) {
      owned = new Set();
      this.bySession.set(args.sessionId, owned);
    }
    owned.add(traceId);
    return handle;
  }

  /** Look up a handle without loading the trace. */
  getHandle(traceId: string): PerfTraceHandle | undefined {
    return this.handles.get(traceId);
  }

  /**
   * Load a trace document by handle. Throws if the trace is unknown
   * or the file disappeared.
   */
  load(traceId: string): TraceDocument {
    const handle = this.handles.get(traceId);
    if (!handle) {
      throw new Error(`PerfTraceStore.load: unknown trace_id=${traceId}`);
    }
    const filePath = this.filePath(traceId);
    if (!fs.existsSync(filePath)) {
      // Drift between in-memory state and disk — fail loudly so the
      // caller can surface an inconclusive_reason rather than silently
      // dropping data.
      throw new Error(`PerfTraceStore.load: trace file missing at ${filePath}`);
    }
    const compressed = fs.readFileSync(filePath);
    const raw = gunzipSync(compressed).toString('utf8');
    const events: TraceEventRecord[] = [];
    let metadata: Record<string, unknown> | undefined;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { kind?: string }).kind === 'metadata'
      ) {
        metadata = (parsed as { metadata?: Record<string, unknown> }).metadata;
        continue;
      }
      events.push(parsed as TraceEventRecord);
    }
    return { traceEvents: events, metadata };
  }

  /**
   * Evict every handle owned by a session, deleting the underlying
   * files. Used when SessionManager emits `session:deleted`.
   */
  evictSession(sessionId: string): number {
    const owned = this.bySession.get(sessionId);
    if (!owned) return 0;
    let removed = 0;
    for (const traceId of owned) {
      this.handles.delete(traceId);
      try {
        fs.unlinkSync(this.filePath(traceId));
      } catch {
        // Best-effort: file may already be gone.
      }
      removed += 1;
    }
    this.bySession.delete(sessionId);
    return removed;
  }

  /** Drop one trace by id (for tests / explicit cleanup). */
  evictTrace(traceId: string): boolean {
    const handle = this.handles.get(traceId);
    if (!handle) return false;
    this.handles.delete(traceId);
    const owned = this.bySession.get(handle.session_id);
    if (owned) {
      owned.delete(traceId);
      if (owned.size === 0) this.bySession.delete(handle.session_id);
    }
    try {
      fs.unlinkSync(this.filePath(traceId));
    } catch {
      // best-effort
    }
    return true;
  }

  /** Number of handles currently retained (for tests). */
  size(): number {
    return this.handles.size;
  }

  /** Reset all in-memory state (tests only — does NOT delete files). */
  clearForTests(): void {
    this.handles.clear();
    this.bySession.clear();
  }
}

/**
 * Process-wide singleton. Tools share one store so a trace captured by
 * `oc_performance_insights` is reachable from `oc_performance_analyze`.
 * Lazy-initialised so test code can override `rootDir` via DI before
 * the first `getPerfTraceStore()` call by passing `setPerfTraceStore()`.
 */
let singleton: PerfTraceStore | null = null;

export function getPerfTraceStore(): PerfTraceStore {
  if (!singleton) {
    singleton = new PerfTraceStore();
  }
  return singleton;
}

/** Tests / advanced wiring: replace the singleton. */
export function setPerfTraceStoreForTests(store: PerfTraceStore | null): void {
  singleton = store;
}
