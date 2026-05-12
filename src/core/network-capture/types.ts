/**
 * Network capture types — shared between lite and full capture modes.
 *
 * Lite mode records request metadata + response headers (no bodies).
 * Full mode adds response bodies up to a configurable cap; bodies above
 * an inline threshold are spilled to disk under
 * `~/.openchrome/network-bodies/<sessionId>/` and referenced by path.
 *
 * The recorder consumes puppeteer's passive event surface only
 * (`page.on('request' | 'response' | 'requestfinished' | 'requestfailed')`).
 * It never calls `page.setRequestInterception(true)` so that the existing
 * `request_intercept` tool retains exclusive ownership of the CDP `Fetch`
 * domain.
 */

export type CaptureMode = 'lite' | 'full';

export type NetworkCaptureBody =
  | { mode: 'inline'; base64: string; bytes: number }
  | { mode: 'file'; path: string; bytes: number }
  | { mode: 'omitted'; reason: 'lite_mode' | 'over_cap' | 'binary_skipped' | 'fetch_failed' };

export interface NetworkCaptureInitiator {
  type: string;
  url?: string;
  lineNumber?: number;
}

export interface NetworkCaptureEntry {
  requestId: string;
  loaderId: string;
  url: string;
  method: string;
  /** "Document" | "XHR" | "Fetch" | "Image" | ... — puppeteer ResourceType string. */
  resourceType: string;
  status?: number;
  statusText?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  timing: {
    startedAt: number;
    respondedAt?: number;
    finishedAt?: number;
  };
  initiator?: NetworkCaptureInitiator;
  body?: NetworkCaptureBody;
  failed?: { errorText: string; canceled: boolean };
}

export interface CaptureOptions {
  /** FIFO ring size. Oldest entries evicted when exceeded. Default 5000. */
  maxEntries: number;
  /** Maximum body bytes recorded in full mode. Default 262144 (256 KB). */
  maxBodyBytes: number;
  /** Glob patterns; if present, only URLs matching at least one are recorded. */
  urlAllowlist?: string[];
  /** Glob patterns; URLs matching any are skipped. Applied after allowlist. */
  urlBlocklist?: string[];
  /** Puppeteer ResourceType strings; if present, only these are recorded. */
  resourceTypes?: string[];
}

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  maxEntries: 5000,
  maxBodyBytes: 262_144,
};

/** Bodies up to this many bytes are inlined as base64. Above → spilled to disk. */
export const INLINE_BODY_THRESHOLD_BYTES = 32 * 1024;
