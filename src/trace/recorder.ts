/**
 * Session trace recorder.
 *
 * Subscribes to CDP events on a per-session CDPSession (typically owned by
 * one Page), buffers them in memory, and flushes JSONL files to disk via
 * `TraceStorage`. A small ring buffer means the steady-state memory cost is
 * bounded; a periodic timer + capacity threshold + page-navigation event +
 * shutdown handler ensure timely flushes without blocking the hot path.
 *
 * Default-off: callers must opt in via `OPENCHROME_TRACE=1` (or by passing
 * `enabled: true` to the constructor). When disabled, the recorder is a
 * no-op and pays zero CPU.
 *
 * The recorder is intentionally decoupled from the broader CDPClient
 * lifecycle — it speaks only to the minimal `EventEmitterLike` interface
 * declared below, which both puppeteer's CDPSession and a unit-test fake
 * satisfy.
 */

import { redactTraceEvent } from './redactor';
import { TraceStorage, defaultTraceRootDir } from './storage';
import type { TraceEvent, TraceSessionMeta, TraceStatus } from './types';

/** Subset of EventEmitter we rely on. */
export interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Subset of puppeteer's Page we rely on for `framenavigated`. Optional. */
export interface PageLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface TraceRecorderOptions {
  storage?: TraceStorage;
  /** Capacity of the in-memory ring buffer per session (default 500). */
  bufferSize?: number;
  /** Periodic flush interval in ms (default 30_000). */
  flushIntervalMs?: number;
  /** Fractional capacity at which a flush is forced (default 0.8). */
  capacityFlushRatio?: number;
  /** When false, every public method is a no-op. */
  enabled?: boolean;
  /** Inject a clock for tests. */
  now?: () => number;
}

/** CDP method names the recorder subscribes to by default. */
export const DEFAULT_TRACE_KINDS = [
  'Page.frameNavigated',
  'Page.loadEventFired',
  'Network.responseReceived',
  'Runtime.consoleAPICalled',
  'DOM.documentUpdated',
] as const;

interface SessionState {
  meta: TraceSessionMeta;
  buffer: TraceEvent[];
  seqCounter: number;
  /** CDP session attached for this recording session, if any. */
  cdp?: EventEmitterLike;
  /** Page attached for this recording session, if any. */
  page?: PageLike;
  /** Per-CDP-event listener registrations so we can detach cleanly. */
  cdpListeners: Array<{ kind: string; fn: (...args: unknown[]) => void }>;
  /** Page listener registration. */
  pageListener?: { event: string; fn: (...args: unknown[]) => void };
  /** Periodic flush timer. */
  timer?: NodeJS.Timeout;
}

export class TraceRecorder {
  private _storage: TraceStorage | null;
  private readonly bufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly capacityFlushRatio: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionState>();

  constructor(opts: TraceRecorderOptions = {}) {
    // Storage is lazy: do NOT touch the filesystem or load `better-sqlite3`
    // until the recorder actually needs to persist. A default-off recorder
    // (env unset) must pay zero cost — initialising TraceStorage in the
    // constructor would defeat that and break in environments where the
    // optional native binding is unavailable.
    this._storage = opts.storage ?? null;
    this.bufferSize = Math.max(1, opts.bufferSize ?? envInt('OPENCHROME_TRACE_BUFFER', 500));
    this.flushIntervalMs = Math.max(
      100,
      opts.flushIntervalMs ?? envInt('OPENCHROME_TRACE_FLUSH_MS', 30_000),
    );
    this.capacityFlushRatio = clamp(opts.capacityFlushRatio ?? 0.8, 0.1, 1.0);
    this.enabled =
      opts.enabled ??
      (process.env.OPENCHROME_TRACE === '1' || process.env.OPENCHROME_TRACE === 'on');
    this.now = opts.now ?? Date.now;
  }

  /**
   * Resolve the storage backend, lazily constructing the default one on
   * first use. Only called from paths gated by `this.enabled`.
   */
  private getStorage(): TraceStorage {
    if (!this._storage) {
      this._storage = new TraceStorage({ rootDir: defaultTraceRootDir() });
    }
    return this._storage;
  }

  /** True when the recorder will actually capture events. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Begin a recording session. Subsequent `recordEvent` / CDP-attached
   * events will be buffered under this session id. Idempotent — calling
   * twice with the same id refreshes meta but preserves the buffer.
   */
  start(meta: Omit<TraceSessionMeta, 'status' | 'byteSize'> & { status?: TraceStatus }): void {
    if (!this.enabled) return;
    const status: TraceStatus = meta.status ?? 'running';
    const existing = this.sessions.get(meta.sessionId);
    if (existing) {
      existing.meta = { ...existing.meta, ...meta, status, byteSize: existing.meta.byteSize };
      this.getStorage().recordSessionStart(existing.meta);
      return;
    }
    const fullMeta: TraceSessionMeta = {
      sessionId: meta.sessionId,
      startedAt: meta.startedAt,
      domain: meta.domain,
      parentOp: meta.parentOp,
      status,
      byteSize: 0,
    };
    this.getStorage().recordSessionStart(fullMeta);
    const state: SessionState = {
      meta: fullMeta,
      buffer: [],
      seqCounter: 0,
      cdpListeners: [],
    };
    state.timer = setInterval(() => {
      this.fireAndForgetFlush(meta.sessionId);
    }, this.flushIntervalMs);
    if (typeof state.timer.unref === 'function') state.timer.unref();
    this.sessions.set(meta.sessionId, state);
  }

  /**
   * Attach the recorder to a CDPSession-like emitter. Listeners are
   * registered for each `kinds` entry; when `page` is supplied, we also
   * trigger a flush on `framenavigated` (matching the v2 flush policy).
   */
  attach(
    sessionId: string,
    cdp: EventEmitterLike,
    page?: PageLike,
    opts: { kinds?: readonly string[] } = {},
  ): void {
    if (!this.enabled) return;
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`TraceRecorder.attach: unknown session "${sessionId}". Call start() first.`);
    }
    if (state.cdp) {
      throw new Error(`TraceRecorder.attach: session "${sessionId}" already attached.`);
    }
    state.cdp = cdp;
    const kinds = opts.kinds ?? DEFAULT_TRACE_KINDS;
    for (const kind of kinds) {
      const fn = (...args: unknown[]): void => {
        const body = args.length === 1 ? args[0] : args;
        this.recordEvent(sessionId, kind, body);
      };
      cdp.on(kind, fn);
      state.cdpListeners.push({ kind, fn });
    }
    if (page) {
      state.page = page;
      const navListener = (): void => {
        // Flush on each navigation boundary so per-URL slices land in
        // distinct files (helpful for replay / time-travel).
        this.fireAndForgetFlush(sessionId);
      };
      page.on('framenavigated', navListener);
      state.pageListener = { event: 'framenavigated', fn: navListener };
    }
  }

  /**
   * Append a synthetic event to the session buffer (e.g., tool_call,
   * screenshot, contract verdict). Triggers a capacity flush if the
   * buffer crosses the configured fill ratio.
   */
  recordEvent(sessionId: string, kind: string, body: unknown): void {
    if (!this.enabled) return;
    const state = this.sessions.get(sessionId);
    if (!state) return; // silently drop — recorder may have been ended
    const event: TraceEvent = {
      ts: this.now(),
      seq: ++state.seqCounter,
      kind,
      body,
    };
    state.buffer.push(redactTraceEvent(event));
    // Drop oldest if we somehow exceed the cap (shouldn't happen with
    // capacity flush, but provides a hard safety net).
    while (state.buffer.length > this.bufferSize) {
      state.buffer.shift();
    }
    if (state.buffer.length >= Math.ceil(this.bufferSize * this.capacityFlushRatio)) {
      this.fireAndForgetFlush(sessionId);
    }
  }

  /**
   * Wrap a fire-and-forget flush so a rejection never escapes as an
   * unhandled-promise: capacity, timer, and navigation flushes are all
   * void-typed, and an unhandled rejection there can crash Node when
   * `--unhandled-rejections=strict` is active. The events stay in the
   * buffer (per the flush() contract) so the next attempt will retry.
   */
  private fireAndForgetFlush(sessionId: string): void {
    this.flush(sessionId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[TraceRecorder] flush failed for session=${sessionId}: ${msg} ` +
          '(events remain buffered for next flush attempt)',
      );
    });
  }

  /**
   * Force-flush the in-memory buffer to disk for a session. The events stay
   * in the buffer until persistence succeeds; if `appendEvents` throws (disk
   * full, permission error, sqlite write failure), the events are preserved
   * for the next flush attempt instead of being silently dropped.
   */
  async flush(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    const state = this.sessions.get(sessionId);
    if (!state || state.buffer.length === 0) return;
    // Snapshot the current buffer prefix; do NOT remove yet.
    const batch = state.buffer.slice();
    const result = this.getStorage().appendEvents(sessionId, batch);
    // Persistence succeeded — drop the persisted prefix. Anything appended
    // by recordEvent during the (synchronous) write stays at the tail.
    state.buffer.splice(0, batch.length);
    state.meta.byteSize += result.bytes;
  }

  /**
   * Finalize a session: flush remaining buffer, detach listeners, clear
   * the periodic timer, and write the terminal status to the index.
   *
   * Cleanup of listeners / timer / session entry is run inside `finally`
   * so a `flush()` rejection (disk full, sqlite write failure) cannot
   * leave the recorder still subscribed to CDP/page events with a live
   * timer for a session the caller intended to close. The flush
   * rejection is re-thrown after cleanup so callers learn that some
   * events did not persist; `shutdown()` already swallows per-session
   * errors so a single bad session never blocks the rest.
   */
  async end(sessionId: string, status: TraceStatus = 'completed'): Promise<void> {
    if (!this.enabled) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;
    let flushError: unknown;
    try {
      await this.flush(sessionId);
    } catch (err) {
      flushError = err;
    }
    try {
      if (state.cdp) {
        for (const { kind, fn } of state.cdpListeners) {
          const off = state.cdp.off ?? state.cdp.removeListener;
          if (off) off.call(state.cdp, kind, fn);
        }
      }
      if (state.page && state.pageListener) {
        // Page may not have an off(); use removeListener fallback when present.
        const pageOff = (state.page as unknown as { off?: typeof state.page.on; removeListener?: typeof state.page.on }).off
          ?? (state.page as unknown as { removeListener?: typeof state.page.on }).removeListener;
        if (pageOff) pageOff.call(state.page, state.pageListener.event, state.pageListener.fn);
      }
      if (state.timer) clearInterval(state.timer);
      // Best-effort terminal write; swallow storage failure here so
      // cleanup completes. The flushError (if any) still surfaces below.
      try {
        this.getStorage().recordSessionEnd(sessionId, {
          endedAt: this.now(),
          status: flushError ? 'failed' : status,
          byteSize: state.meta.byteSize,
        });
      } catch (err) {
        if (!flushError) flushError = err;
      }
    } finally {
      this.sessions.delete(sessionId);
    }
    if (flushError) throw flushError;
  }

  /**
   * Flush + end every active session. Intended to be wired to process
   * `beforeExit` / SIGTERM by the host so traces survive a clean shutdown.
   */
  async shutdown(status: TraceStatus = 'aborted'): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      try {
        await this.end(id, status);
      } catch {
        // best-effort during shutdown
      }
    }
  }

  /** For tests: peek at the in-memory buffer without flushing. */
  _peekBuffer(sessionId: string): TraceEvent[] {
    return this.sessions.get(sessionId)?.buffer.slice() ?? [];
  }

  /** For tests: has storage been instantiated yet (lazy-init guard)? */
  _storageInitializedForTests(): boolean {
    return this._storage !== null;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

let _global: TraceRecorder | null = null;
/**
 * Process-wide singleton. The first call decides options; subsequent calls
 * return the same instance regardless of arguments. Hosts that need
 * per-test isolation should construct `new TraceRecorder({...})` directly.
 */
export function getTraceRecorder(opts?: TraceRecorderOptions): TraceRecorder {
  if (!_global) _global = new TraceRecorder(opts);
  return _global;
}

/** Test-only: reset the global singleton. */
export function _resetTraceRecorderForTests(): void {
  _global = null;
}
