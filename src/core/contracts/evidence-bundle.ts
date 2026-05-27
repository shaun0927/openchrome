/**
 * Evidence bundle generator (issue #792).
 *
 * Captures a snapshot of the current page state into a flat directory under
 * `<rootDir>/<bundle_id>/`. Each requested part is written as a separate
 * file; the `parts` array returned by `writeEvidenceBundle` enumerates the
 * relative filenames that were produced.
 *
 * This module is intentionally standalone: it does NOT depend on the pilot
 * contract runtime (#749), the live browser, or any third-party archiver.
 * Inputs arrive as a plain JS object (see `EvidenceBundleSnapshot`) supplied
 * by the caller — today the MCP tool surfaces it directly; a future PR will
 * have `oc_assert` produce an `evidence_handle` that materializes to one of
 * these snapshots.
 *
 * Why flat layout instead of a ZIP archive?
 *   The repo intentionally avoids a hard `archiver` dependency for this
 *   first cut. The bundle directory is the unit of consumption; future
 *   tooling can zip it on demand.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { phashFromPng, phashToHex } from '../../contracts/phash';
import {
  diffAgainstSchema,
  SchemaDefinition,
  SchemaDiff,
} from './schema-diff';

/** Parts the caller can request. Each maps to a file in the bundle dir. */
export type EvidenceBundlePart =
  | 'dom'
  | 'screenshot'
  | 'network'
  | 'console'
  | 'phash'
  | 'schema_diff';

/** Default include set — cheap parts that almost every caller wants. */
export const DEFAULT_INCLUDE: readonly EvidenceBundlePart[] = ['dom', 'screenshot'];

/** Default rolling window for the network slice. */
export const DEFAULT_NETWORK_WINDOW_MS = 5000;

/** One captured network entry. Shape mirrors the existing NetworkActivityLog. */
export interface NetworkEntry {
  /** Epoch ms when the request started. */
  started_at?: number;
  url?: string;
  method?: string;
  status?: number;
  /** Free-form additional fields are preserved as-is. */
  [k: string]: unknown;
}

/** One captured console entry. */
export interface ConsoleEntry {
  /** Epoch ms when the entry was emitted. */
  ts?: number;
  level?: string;
  text?: string;
  [k: string]: unknown;
}

/**
 * Caller-supplied snapshot of the current page state. Every field is
 * optional; missing fields cause the corresponding part to fall through
 * gracefully (the part name is omitted from the result's `parts` array).
 */
export interface EvidenceBundleSnapshot {
  /** Serialized DOM (HTML string or a JSON-serializable object). */
  dom?: string | Record<string, unknown> | null;
  /** PNG bytes (Buffer) or base64-encoded PNG string. */
  screenshot_png?: Buffer | string;
  /** All captured network entries — `network_window_ms` filters them. */
  network?: NetworkEntry[];
  /** All captured console entries — last N (by ts) are kept. */
  console?: ConsoleEntry[];
  /** Optional clock used for the network window. Defaults to `Date.now()`. */
  now_ms?: number;
  /**
   * Caller-supplied structured data extracted from the page. Diffed against
   * `EvidenceBundleOptions.targetSchema` (B1-PR1 schema-diff) when both
   * are present and the `schema_diff` part is included. Opaque to the
   * bundle writer beyond the diff step.
   */
  observed?: unknown;
}

export interface EvidenceBundleOptions {
  /**
   * Root directory; defaults to `<os.tmpdir()>/openchrome-evidence`. The
   * tmpdir default keeps tests from polluting `~/.openchrome`.
   */
  rootDir?: string;
  /** Filter for which parts to capture. Default = DEFAULT_INCLUDE. */
  include?: readonly EvidenceBundlePart[];
  /** Network slice window in ms. Default = DEFAULT_NETWORK_WINDOW_MS. */
  networkWindowMs?: number;
  /** Cap for console entries kept. Default = 200. */
  consoleMaxEntries?: number;
  /**
   * Declared target schema. When supplied together with
   * `snapshot.observed` and the `schema_diff` part is included, the
   * bundle writer computes a structured diff and writes
   * `schema_diff.json` to the bundle directory.
   */
  targetSchema?: SchemaDefinition;
}

export interface EvidenceBundleResult {
  bundle_id: string;
  /** Absolute path to the directory containing the bundle parts. */
  path: string;
  /** Total bytes written across all parts (excluding the directory itself). */
  size_bytes: number;
  /** Relative filenames written, in capture order. */
  parts: string[];
  /**
   * Schema diff summary, present iff the bundle wrote `schema_diff.json`.
   * Mirrors the on-disk file so single-call consumers don't have to
   * re-read it.
   */
  schema_diff?: SchemaDiff;
}

const CONSOLE_MAX_DEFAULT = 200;

/** Compute the default root dir for evidence bundles. */
export function defaultEvidenceRootDir(): string {
  return path.join(os.tmpdir(), 'openchrome-evidence');
}

/**
 * Write an evidence bundle to disk and return its metadata.
 *
 * Missing inputs are silently dropped from `parts` — the function never
 * throws on a missing field, only on actual filesystem errors. Callers can
 * treat an empty `parts` array as the "inconclusive" outcome.
 */
export function writeEvidenceBundle(
  snapshot: EvidenceBundleSnapshot,
  opts: EvidenceBundleOptions = {},
): EvidenceBundleResult {
  const include = normalizeInclude(opts.include);
  const rootDir = opts.rootDir ?? defaultEvidenceRootDir();
  const bundleId = crypto.randomUUID();
  const bundleDir = path.join(rootDir, bundleId);
  fs.mkdirSync(bundleDir, { recursive: true });

  const parts: string[] = [];
  let totalBytes = 0;

  // ── DOM ───────────────────────────────────────────────────────────────
  if (include.has('dom') && snapshot.dom !== undefined && snapshot.dom !== null) {
    const filename = 'dom.json';
    const payload =
      typeof snapshot.dom === 'string'
        ? JSON.stringify({ format: 'html', html: snapshot.dom }, null, 2)
        : JSON.stringify(snapshot.dom, null, 2);
    totalBytes += writePart(bundleDir, filename, payload);
    parts.push(filename);
  }

  // ── Screenshot ────────────────────────────────────────────────────────
  let screenshotBuffer: Buffer | null = null;
  if (include.has('screenshot') && snapshot.screenshot_png !== undefined) {
    screenshotBuffer = coerceScreenshot(snapshot.screenshot_png);
    if (screenshotBuffer !== null) {
      const filename = 'screenshot.png';
      totalBytes += writePart(bundleDir, filename, screenshotBuffer);
      parts.push(filename);
    }
  }

  // ── Network slice ─────────────────────────────────────────────────────
  if (include.has('network') && Array.isArray(snapshot.network)) {
    const windowMs = readWindowMs(opts.networkWindowMs);
    const now = typeof snapshot.now_ms === 'number' ? snapshot.now_ms : Date.now();
    const cutoff = now - windowMs;
    const sliced = snapshot.network.filter((entry) => {
      const ts = typeof entry.started_at === 'number' ? entry.started_at : now;
      return ts >= cutoff;
    });
    const filename = 'network.json';
    const payload = JSON.stringify(
      { window_ms: windowMs, captured_at: now, entries: sliced },
      null,
      2,
    );
    totalBytes += writePart(bundleDir, filename, payload);
    parts.push(filename);
  }

  // ── Console slice ─────────────────────────────────────────────────────
  if (include.has('console') && Array.isArray(snapshot.console)) {
    const cap = readConsoleCap(opts.consoleMaxEntries);
    // Keep the most recent `cap` entries, preserving original order.
    const slice =
      snapshot.console.length > cap ? snapshot.console.slice(-cap) : snapshot.console.slice();
    const filename = 'console.json';
    const payload = JSON.stringify({ max_entries: cap, entries: slice }, null, 2);
    totalBytes += writePart(bundleDir, filename, payload);
    parts.push(filename);
  }

  // ── Schema diff ───────────────────────────────────────────────────────
  let schemaDiff: SchemaDiff | undefined;
  if (
    include.has('schema_diff') &&
    opts.targetSchema !== undefined &&
    snapshot.observed !== undefined
  ) {
    schemaDiff = diffAgainstSchema(opts.targetSchema, snapshot.observed);
    const filename = 'schema_diff.json';
    const payload = JSON.stringify(
      {
        target_schema_version: opts.targetSchema.version,
        diff: schemaDiff,
      },
      null,
      2,
    );
    totalBytes += writePart(bundleDir, filename, payload);
    parts.push(filename);
  }

  // ── Perceptual hash ───────────────────────────────────────────────────
  if (include.has('phash')) {
    // If the caller didn't ask for the screenshot part but did ask for
    // phash, still try to decode the supplied PNG so we can compute it.
    const pngForPhash =
      screenshotBuffer ?? coerceScreenshot(snapshot.screenshot_png);
    if (pngForPhash !== null) {
      try {
        const hash = phashFromPng(pngForPhash);
        const filename = 'phash.json';
        const payload = JSON.stringify(
          { algorithm: 'dct-ii-8x8', hash_hex: phashToHex(hash) },
          null,
          2,
        );
        totalBytes += writePart(bundleDir, filename, payload);
        parts.push(filename);
      } catch (err) {
        // phash is best-effort: a malformed PNG should not abort the bundle.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[evidence-bundle] phash skipped: ${message}`);
      }
    }
  }

  return {
    bundle_id: bundleId,
    path: bundleDir,
    size_bytes: totalBytes,
    parts,
    ...(schemaDiff !== undefined ? { schema_diff: schemaDiff } : {}),
  };
}

// ─── Internals ───────────────────────────────────────────────────────────

function normalizeInclude(
  include: readonly EvidenceBundlePart[] | undefined,
): Set<EvidenceBundlePart> {
  if (!include || include.length === 0) {
    return new Set(DEFAULT_INCLUDE);
  }
  const valid: EvidenceBundlePart[] = ['dom', 'screenshot', 'network', 'console', 'phash', 'schema_diff'];
  const out = new Set<EvidenceBundlePart>();
  for (const item of include) {
    if ((valid as string[]).includes(item)) out.add(item);
  }
  return out;
}

function readWindowMs(supplied: number | undefined): number {
  if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0) {
    return supplied;
  }
  return DEFAULT_NETWORK_WINDOW_MS;
}

function readConsoleCap(supplied: number | undefined): number {
  if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied > 0) {
    return Math.floor(supplied);
  }
  return CONSOLE_MAX_DEFAULT;
}

function coerceScreenshot(input: Buffer | string | undefined): Buffer | null {
  if (input === undefined) return null;
  if (Buffer.isBuffer(input)) return input.length > 0 ? input : null;
  if (typeof input === 'string' && input.length > 0) {
    try {
      const buf = Buffer.from(input, 'base64');
      return buf.length > 0 ? buf : null;
    } catch {
      return null;
    }
  }
  return null;
}

function writePart(dir: string, filename: string, payload: string | Buffer): number {
  const target = path.join(dir, filename);
  if (typeof payload === 'string') {
    fs.writeFileSync(target, payload, 'utf8');
    return Buffer.byteLength(payload, 'utf8');
  }
  fs.writeFileSync(target, payload);
  return payload.length;
}
