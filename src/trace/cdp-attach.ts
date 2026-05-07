/**
 * Glue between the CDP layer (`src/cdp/client.ts`) and the trace recorder
 * (`src/trace/recorder.ts`). The CDP module owns the page lifecycle; this
 * module owns the recorder lifecycle and binds them with one entry point
 * the host calls right after a page is created.
 *
 * Default-off — every public entry point checks `OPENCHROME_TRACE` and
 * returns immediately when disabled. Any thrown error is captured by the
 * caller (`createPage` wraps the call in try/catch) so a recorder bug
 * cannot regress page creation.
 *
 * Imported lazily by `client.ts` so consumers that never enable tracing
 * do not pay the recorder's startup cost (no ring buffer allocation, no
 * SQLite handle, no timer registered).
 */

import { getTraceRecorder } from './recorder';
import type { TraceRecorder } from './recorder';

/** Subset of puppeteer's Page that we touch. */
interface PageLike {
  target(): { _targetId?: string; type(): string };
  on(event: 'close', listener: () => void): unknown;
  on(event: 'framenavigated', listener: (...args: unknown[]) => void): unknown;
  createCDPSession(): Promise<{
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    off?(event: string, listener: (...args: unknown[]) => void): unknown;
    detach?(): Promise<void>;
  }>;
}

export interface AttachOptions {
  /** Stable session id — typically the page's CDP target id. */
  sessionId: string;
  /** eTLD+1 for the page's first navigation, when known. */
  domain?: string;
  /** Logging label (`tool:click`, `cdp.createPage`, …). */
  parentOp?: string;
}

/** True when the OPENCHROME_TRACE env flag is on. */
export function traceEnvEnabled(): boolean {
  const v = process.env.OPENCHROME_TRACE;
  return v === '1' || v === 'on' || v === 'true';
}

/**
 * Attach the global trace recorder to a freshly-created page. Idempotent:
 * a second call for the same `sessionId` is a silent no-op.
 *
 * The session ends automatically when the page emits `close`. Hosts that
 * want to end earlier (graceful shutdown) should call
 * `getTraceRecorder().end(sessionId, status)` directly.
 */
export async function attachRecorderToPage(
  page: PageLike,
  opts: AttachOptions,
): Promise<TraceRecorder | null> {
  if (!traceEnvEnabled()) return null;

  const recorder = getTraceRecorder();
  if (!recorder.isEnabled()) {
    // Recorder constructed before env was set — caller should reset the
    // singleton via `_resetTraceRecorderForTests()` if it really wants
    // tracing on. We surface this as a console error and bail rather than
    // silently no-op.
    console.error(
      '[trace] OPENCHROME_TRACE is set but the recorder singleton is disabled (constructed before env). Call _resetTraceRecorderForTests() in test setup to refresh.',
    );
    return null;
  }

  recorder.start({
    sessionId: opts.sessionId,
    startedAt: Date.now(),
    domain: opts.domain,
    parentOp: opts.parentOp ?? 'cdp.createPage',
  });

  // CDPSession creation is async and can fail on an already-closed target.
  // We swallow that — the recorder gets the lifecycle event from `close`.
  try {
    const cdp = await page.createCDPSession();
    recorder.attach(opts.sessionId, cdp, page);
  } catch (err) {
    console.error('[trace] createCDPSession failed; recorder will receive no CDP events:', err);
  }

  // Auto-end on page close. Page emits close exactly once per page, so we
  // don't need an off-listener.
  page.on('close', () => {
    void recorder.end(opts.sessionId, 'completed');
  });

  return recorder;
}
