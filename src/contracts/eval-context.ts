/**
 * Narrow interface that the runtime (#706) implements to drive
 * assertion evaluation. Decoupling here keeps the `contracts/` module
 * unit-testable without a real Chromium attached.
 *
 * All methods are async because the live runtime fulfils them via CDP.
 * Evaluators MUST NOT call any other I/O — `EvalContext` is the only
 * permitted seam between the data layer and the world.
 */

import type { NetworkSinceMarker } from './types';

export interface NetworkLogEntry {
  url: string;
  status: number;
  /** Wall-clock timestamp in ms (Date.now() origin). */
  ts: number;
}

export interface EvalContext {
  /** Current top-frame URL. */
  url(): Promise<string>;

  /** innerText of the first node matching `selector`; defaults to `body`. */
  domText(selector: string | undefined): Promise<string | null>;

  /** Number of nodes matching `selector` in the active frame tree. */
  domCount(selector: string): Promise<number>;

  /** Network entries since the requested marker (oldest-first). */
  networkSince(marker: NetworkSinceMarker): Promise<NetworkLogEntry[]>;

  /** Most recent screenshot as a PNG buffer, or null when unavailable. */
  screenshotPng(): Promise<Buffer | null>;

  /** True iff a JS dialog (alert/confirm/prompt/beforeunload) is open. */
  hasOpenDialog(): Promise<boolean>;

  // ─── Evidence enrichment hooks (all optional) ─────────────────────────────

  /** If the runtime knows where the current screenshot was persisted. */
  screenshotPath?(): Promise<string | undefined>;

  /** Trace window for the slice this evaluation should reference. */
  traceWindow?(): Promise<{ trace_id: string; from_ts: number; to_ts: number } | undefined>;

  /**
   * Lookup hook for screenshot classes (lets tests inject a fake registry,
   * and lets the runtime cache the on-disk class in memory).
   *
   * `score()` deliberately returns only `{ distance, exemplar }`. The
   * evaluator decides `passed` itself by comparing `distance` to the
   * assertion's `distance_max`, so the recommended `threshold` carried on
   * the parent object is informational (surfaced as `threshold_recommended`
   * in evidence) rather than the gating value.
   */
  loadScreenshotClass?(class_id: string): Promise<{
    threshold: number;
    score: (candidate: bigint) => { distance: number; exemplar: string };
  }>;
}
