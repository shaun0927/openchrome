/**
 * NetworkCaptureRecorder — passive request/response recorder.
 *
 * Uses puppeteer's high-level event surface only:
 *   page.on('request', ...)
 *   page.on('response', ...)
 *   page.on('requestfailed', ...)
 *   page.on('requestfinished', ...)
 *
 * Critically, this recorder does NOT call `page.setRequestInterception(true)`
 * and does NOT call `Network.enable`/`Network.disable` directly — the
 * `'request'` / `'response'` events fire from puppeteer's already-attached
 * Network listener regardless of who else is listening. This means
 * `request_intercept` (which owns the `setRequestInterception` lifecycle)
 * and the recorder can coexist without contention; both observe the same
 * requests, only `request_intercept` mutates them.
 *
 * In `lite` mode, response bodies are never fetched — entries record
 * `body: { mode: 'omitted', reason: 'lite_mode' }`.
 *
 * In `full` mode, responses up to `maxBodyBytes` are buffered via
 * `response.buffer()`. Bodies up to `INLINE_BODY_THRESHOLD_BYTES` are
 * inlined as base64 on the entry; larger bodies are spilled to disk via
 * `body-store.ts`. Bodies exceeding `maxBodyBytes` are recorded as
 * `body: { mode: 'omitted', reason: 'over_cap' }`.
 *
 * Sensitive headers are redacted via `core/trace/redactor.ts`.
 */

import type { Page, HTTPRequest, HTTPResponse } from 'puppeteer-core';
import {
  CaptureMode,
  CaptureOptions,
  DEFAULT_CAPTURE_OPTIONS,
  INLINE_BODY_THRESHOLD_BYTES,
  NetworkCaptureEntry,
} from './types';
import { cleanupSession, writeBody } from './body-store';
import { redactValue } from '../trace/redactor';

const LOG_PREFIX = '[NetworkCapture]';

type GenericListener = (...args: unknown[]) => unknown;

interface RecorderListeners {
  request: GenericListener;
  response: GenericListener;
  requestfailed: GenericListener;
  requestfinished: GenericListener;
}

/**
 * Convert a glob pattern (`*`, `?`) into a case-insensitive regex.
 * `**` is treated identically to `*` (path-segments are not significant for
 * URLs in this matcher).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${expanded}$`, 'i');
}

/** True iff `url` matches at least one of `patterns`. */
function matchesAnyPattern(url: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (globToRegExp(p).test(url)) return true;
    } catch {
      if (url.includes(p)) return true;
    }
  }
  return false;
}

/**
 * Apply trace redactor to a header bag. The redactor returns an unknown shape
 * but for header bags it always preserves the record shape.
 */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out = redactValue({ headers }) as { headers: Record<string, string> };
  return out.headers;
}

export class NetworkCaptureRecorder {
  private readonly page: Page;
  private readonly sessionId: string;
  private readonly mode: CaptureMode;
  private readonly options: CaptureOptions;

  private listeners: RecorderListeners | null = null;
  private entries: NetworkCaptureEntry[] = [];
  /** Map from puppeteer request -> entry so we can join request/response events. */
  private readonly requestIndex = new Map<HTTPRequest, NetworkCaptureEntry>();
  /** Monotonic counter for synthesizing requestIds (puppeteer does not expose CDP IDs reliably). */
  private requestSeq = 0;
  private startedAt = 0;

  constructor(
    page: Page,
    sessionId: string,
    mode: CaptureMode,
    options?: Partial<CaptureOptions>,
  ) {
    this.page = page;
    this.sessionId = sessionId;
    this.mode = mode;
    this.options = { ...DEFAULT_CAPTURE_OPTIONS, ...(options || {}) };
  }

  /** True once `start()` has attached listeners and not yet been stopped. */
  isActive(): boolean {
    return this.listeners !== null;
  }

  getMode(): CaptureMode {
    return this.mode;
  }

  getOptions(): CaptureOptions {
    return this.options;
  }

  /**
   * Attach passive listeners. Idempotency is the caller's responsibility —
   * `start()` on an already-active recorder throws so the tool layer can
   * surface `already_capturing`.
   */
  start(): void {
    if (this.listeners) {
      throw new Error('NetworkCaptureRecorder.start: already active');
    }
    this.startedAt = Date.now();

    const onRequest = (request: HTTPRequest) => {
      try {
        this.handleRequest(request);
      } catch (err) {
        console.error(`${LOG_PREFIX} onRequest error:`, err);
      }
    };
    const onResponse = (response: HTTPResponse) => {
      // Fire-and-forget. We intentionally do not await — puppeteer's event
      // dispatcher does not surface async errors meaningfully, and stalling
      // the dispatcher would slow every subsequent network event.
      this.handleResponse(response).catch((err) => {
        console.error(`${LOG_PREFIX} onResponse error:`, err);
      });
    };
    const onRequestFailed = (request: HTTPRequest) => {
      try {
        this.handleRequestFailed(request);
      } catch (err) {
        console.error(`${LOG_PREFIX} onRequestFailed error:`, err);
      }
    };
    const onRequestFinished = (request: HTTPRequest) => {
      try {
        this.handleRequestFinished(request);
      } catch (err) {
        console.error(`${LOG_PREFIX} onRequestFinished error:`, err);
      }
    };

    this.page.on('request', onRequest);
    this.page.on('response', onResponse);
    this.page.on('requestfailed', onRequestFailed);
    this.page.on('requestfinished', onRequestFinished);

    this.listeners = {
      request: onRequest as unknown as GenericListener,
      response: onResponse as unknown as GenericListener,
      requestfailed: onRequestFailed as unknown as GenericListener,
      requestfinished: onRequestFinished as unknown as GenericListener,
    };
  }

  /**
   * Detach listeners, drain the request index, and optionally purge any
   * on-disk bodies for this session.
   */
  async stop(opts: { keepBodies?: boolean } = {}): Promise<void> {
    if (!this.listeners) return;
    this.page.off('request', this.listeners.request as never);
    this.page.off('response', this.listeners.response as never);
    this.page.off('requestfailed', this.listeners.requestfailed as never);
    this.page.off('requestfinished', this.listeners.requestfinished as never);
    this.listeners = null;
    this.requestIndex.clear();

    if (!opts.keepBodies) {
      await cleanupSession(this.sessionId);
    }
  }

  /** Wipe in-memory entries. Does NOT touch on-disk bodies. */
  clear(): void {
    this.entries = [];
  }

  /**
   * Return the most recent entries. Default `limit` = 100. `limit:0` returns
   * the full ring up to `maxEntries`.
   */
  getLogs(limit?: number): NetworkCaptureEntry[] {
    const effectiveLimit = limit === 0 ? this.entries.length : (limit ?? 100);
    // Entries are pushed in chronological order; return newest-first.
    const slice = effectiveLimit >= this.entries.length
      ? this.entries.slice()
      : this.entries.slice(this.entries.length - effectiveLimit);
    return slice.slice().reverse();
  }

  /** Diagnostic: count of entries currently retained in memory. */
  getEntryCount(): number {
    return this.entries.length;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  // ─── event handlers ────────────────────────────────────────────────────

  private handleRequest(request: HTTPRequest): void {
    const url = request.url();
    if (!this.shouldRecord(url, request.resourceType())) return;

    const requestId = `r-${++this.requestSeq}-${Date.now().toString(36)}`;
    const initiator = request.initiator();
    const entry: NetworkCaptureEntry = {
      requestId,
      loaderId: requestId, // Puppeteer's high-level API doesn't expose CDP loaderId; reuse requestId.
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      requestHeaders: redactHeaders(request.headers() || {}),
      timing: { startedAt: Date.now() },
      initiator: initiator
        ? {
            type: initiator.type,
            url: initiator.url,
            lineNumber: initiator.lineNumber,
          }
        : undefined,
      body:
        this.mode === 'lite'
          ? { mode: 'omitted', reason: 'lite_mode' }
          : undefined,
    };
    this.requestIndex.set(request, entry);
    this.pushEntry(entry);
  }

  private async handleResponse(response: HTTPResponse): Promise<void> {
    const request = response.request();
    const entry = this.requestIndex.get(request);
    if (!entry) return;

    entry.status = response.status();
    entry.statusText = response.statusText();
    entry.responseHeaders = redactHeaders(response.headers() || {});
    entry.timing.respondedAt = Date.now();

    if (this.mode !== 'full') return;

    // Try to enforce maxBodyBytes via Content-Length when present. Puppeteer
    // does not expose a chunked-streaming API on HTTPResponse, so we must
    // buffer the full body to inspect its length. To keep memory bounded for
    // unknown-length responses, we pre-check Content-Length and skip the
    // fetch entirely when it exceeds maxBodyBytes.
    const cl = response.headers()['content-length'];
    if (cl) {
      const declared = Number.parseInt(cl, 10);
      if (Number.isFinite(declared) && declared > this.options.maxBodyBytes) {
        entry.body = { mode: 'omitted', reason: 'over_cap' };
        return;
      }
    }

    let buffer: Buffer;
    try {
      buffer = await response.buffer();
    } catch {
      // Body unavailable (redirects, navigation-cancelled, etc.) — record as
      // omitted with a fetch_failed reason so the agent can distinguish.
      entry.body = { mode: 'omitted', reason: 'fetch_failed' };
      return;
    }

    if (buffer.length > this.options.maxBodyBytes) {
      entry.body = { mode: 'omitted', reason: 'over_cap' };
      return;
    }

    if (buffer.length <= INLINE_BODY_THRESHOLD_BYTES) {
      entry.body = {
        mode: 'inline',
        base64: buffer.toString('base64'),
        bytes: buffer.length,
      };
      return;
    }

    try {
      const filePath = await writeBody(this.sessionId, entry.requestId, buffer);
      entry.body = { mode: 'file', path: filePath, bytes: buffer.length };
    } catch (err) {
      console.error(`${LOG_PREFIX} writeBody failed for ${entry.requestId}:`, err);
      entry.body = { mode: 'omitted', reason: 'fetch_failed' };
    }
  }

  private handleRequestFailed(request: HTTPRequest): void {
    const entry = this.requestIndex.get(request);
    if (!entry) return;
    const failure = request.failure();
    entry.failed = {
      errorText: failure?.errorText || 'unknown',
      canceled: failure?.errorText === 'net::ERR_ABORTED',
    };
    entry.timing.finishedAt = Date.now();
    this.requestIndex.delete(request);
  }

  private handleRequestFinished(request: HTTPRequest): void {
    const entry = this.requestIndex.get(request);
    if (!entry) return;
    entry.timing.finishedAt = Date.now();
    this.requestIndex.delete(request);
  }

  // ─── filter + ring-buffer helpers ──────────────────────────────────────

  private shouldRecord(url: string, resourceType: string): boolean {
    if (this.options.resourceTypes && this.options.resourceTypes.length > 0) {
      if (!this.options.resourceTypes.includes(resourceType)) return false;
    }
    if (this.options.urlAllowlist && this.options.urlAllowlist.length > 0) {
      if (!matchesAnyPattern(url, this.options.urlAllowlist)) return false;
    }
    if (this.options.urlBlocklist && this.options.urlBlocklist.length > 0) {
      if (matchesAnyPattern(url, this.options.urlBlocklist)) return false;
    }
    return true;
  }

  private pushEntry(entry: NetworkCaptureEntry): void {
    this.entries.push(entry);
    // FIFO eviction. The oldest entry's request may still be in `requestIndex`;
    // we drop the index mapping to allow GC even if its lifecycle hasn't ended.
    while (this.entries.length > this.options.maxEntries) {
      const evicted = this.entries.shift();
      if (evicted) {
        for (const [req, e] of this.requestIndex) {
          if (e === evicted) {
            this.requestIndex.delete(req);
            break;
          }
        }
      }
    }
  }
}

// ─── module-level active-recorder registry ─────────────────────────────────

/**
 * Mutual-exclusion registry: at most one recorder (lite OR full) per tab.
 * Keyed by `tabId` (puppeteer target id).
 */
const activeRecorders: Map<string, NetworkCaptureRecorder> = new Map();

export function getActiveRecorder(tabId: string): NetworkCaptureRecorder | undefined {
  return activeRecorders.get(tabId);
}

export function setActiveRecorder(tabId: string, rec: NetworkCaptureRecorder): void {
  activeRecorders.set(tabId, rec);
}

export function deleteActiveRecorder(tabId: string): void {
  activeRecorders.delete(tabId);
}

/** Test-only helper: wipe the registry. */
export function _resetActiveRecordersForTests(): void {
  activeRecorders.clear();
}
