/**
 * Evidence bundle generator for failed (and on-demand for any) contract
 * transactions.
 *
 * Per #707 v2:
 *   - Bundle layout under `~/.openchrome/transactions/<txn_id>/`:
 *       bundle.json, pre_screenshot.png, fail_screenshot.png,
 *       lastgood_screenshot.png, fail_dom.json, lastgood_dom.json,
 *       trace_slice.jsonl
 *   - **Atomic write order**: all referenced files written first,
 *     `bundle.json` last via temp + `os.rename`. Readers can rely on
 *     bundle.json existing ⇒ every referenced path resolves. This
 *     gives crash-safety without a subprocess test — the invariant is
 *     structural.
 *   - 5 MB hard cap (`OPENCHROME_BUNDLE_MAX_BYTES`). Oversize inputs
 *     are truncated with an explicit `truncated` flag in the manifest.
 *   - Redaction at write boundary: DOM payloads + trace events flow
 *     through `redactValue` from the trace redactor (#701) before
 *     hitting disk. Audit-log args are NOT included in bundles —
 *     they live in the audit log, not the per-transaction bundle.
 *
 * Image processing (downscaling to 1280px JPEG q80) is intentionally
 * deferred — this PR ships PNG-as-supplied. A follow-up PR adds
 * `sharp` + downscaling once the rest of the pipeline is in place.
 *
 * The MCP resource side (`openchrome://transaction/<txn_id>`) is wired
 * via the prefix-handler primitive added for `openchrome://trace/*`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactValue } from '../trace/redactor';

import type { TransactionRecord, Verdict } from './runtime';

const ONE_MB = 1024 * 1024;
const DEFAULT_MAX_BYTES = 5 * ONE_MB;

const DOM_TRUNCATE_BYTES = 500 * 1024; // 500 KB per DOM snapshot

const MANIFEST_FILENAME = 'bundle.json';
const TMP_MANIFEST_FILENAME = '.bundle.json.tmp';

export interface EvidenceTraceEvent {
  ts: number;
  seq: number;
  kind: string;
  body: unknown;
}

export interface EvidenceBundleInputs {
  transaction: TransactionRecord;
  /** Buffer or path to a screenshot taken before the contract started. */
  pre_screenshot?: Buffer | string;
  /** Buffer or path to a screenshot at the failure moment. */
  fail_screenshot?: Buffer | string;
  /** Buffer or path to a screenshot at the last known-good state hash. */
  lastgood_screenshot?: Buffer | string;
  /** DOM snapshot at the failure moment. JSON-serialisable. */
  fail_dom?: unknown;
  /** Last known-good DOM, for diff context. */
  lastgood_dom?: unknown;
  /** A subset of trace events covering the failure window. */
  trace_slice?: EvidenceTraceEvent[];
  /** Operator/agent-supplied next-step suggestions. */
  suggested_next_steps?: Array<{ id: string; title: string; body: string; confidence?: number }>;
}

export interface EvidenceBundleOptions {
  /** Root directory; defaults to ~/.openchrome/transactions. */
  rootDir?: string;
  /** Hard byte cap; defaults to 5 MB. */
  maxBytes?: number;
}

export interface BundleManifest {
  schema_version: 1;
  txn_id: string;
  contract_id: string;
  verdict: Verdict;
  generated_at: number;
  /** Files in this bundle, keyed by purpose. Paths are relative to the
   *  bundle root (the same directory containing bundle.json). */
  files: {
    pre_screenshot?: string;
    fail_screenshot?: string;
    lastgood_screenshot?: string;
    fail_dom?: string;
    lastgood_dom?: string;
    trace_slice?: string;
  };
  /** Snapshot of the TransactionRecord at write time. */
  transaction: TransactionRecord;
  suggested_next_steps?: EvidenceBundleInputs['suggested_next_steps'];
  /** Per-component truncation flags surfaced for the reader. */
  truncated?: Partial<
    Record<
      | 'fail_dom'
      | 'lastgood_dom'
      | 'trace_slice'
      | 'pre_screenshot'
      | 'fail_screenshot'
      | 'lastgood_screenshot',
      true
    >
  >;
  /** Total bytes written. */
  byte_size: number;
}

export interface BundleWriteResult {
  bundleDir: string;
  manifestPath: string;
  byteSize: number;
}

export function defaultBundleRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'transactions');
}

function readMaxBytes(opts: EvidenceBundleOptions): number {
  if (opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0) {
    return opts.maxBytes;
  }
  const env = process.env.OPENCHROME_BUNDLE_MAX_BYTES;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BYTES;
}

/**
 * Write a complete evidence bundle to disk. Returns the bundle dir +
 * manifest path. Atomic at the readability boundary: bundle.json only
 * appears after every referenced file lands.
 */
export async function writeEvidenceBundle(
  inputs: EvidenceBundleInputs,
  opts: EvidenceBundleOptions = {},
): Promise<BundleWriteResult> {
  const rootDir = opts.rootDir ?? defaultBundleRootDir();
  const maxBytes = readMaxBytes(opts);
  const bundleDir = path.join(rootDir, inputs.transaction.txn_id);
  fs.mkdirSync(bundleDir, { recursive: true });

  const files: BundleManifest['files'] = {};
  const truncated: BundleManifest['truncated'] = {};
  let byteSize = 0;

  // --- Screenshots (write as supplied; downscaling deferred) ---
  // Pass `maxBytes` so a single failure-frame PNG larger than the cap is
  // dropped (and surfaced via `truncated`) rather than silently blowing
  // past the documented hard ceiling. The trace-slice path below already
  // applies the same accounting; without this, screenshots could exceed
  // OPENCHROME_BUNDLE_MAX_BYTES by megabytes on failure-heavy runs.
  const skipped: Array<keyof BundleManifest['files']> = [];
  byteSize += writeScreenshot(bundleDir, 'pre_screenshot.png', inputs.pre_screenshot, files, 'pre_screenshot', byteSize, maxBytes, skipped);
  byteSize += writeScreenshot(bundleDir, 'fail_screenshot.png', inputs.fail_screenshot, files, 'fail_screenshot', byteSize, maxBytes, skipped);
  byteSize += writeScreenshot(bundleDir, 'lastgood_screenshot.png', inputs.lastgood_screenshot, files, 'lastgood_screenshot', byteSize, maxBytes, skipped);
  for (const key of skipped) {
    (truncated as Record<string, true>)[key] = true;
  }

  // --- DOM snapshots (redacted, truncated when oversize) ---
  if (inputs.fail_dom !== undefined) {
    const r = writeJsonSnapshot(bundleDir, 'fail_dom.json', inputs.fail_dom, DOM_TRUNCATE_BYTES);
    files.fail_dom = 'fail_dom.json';
    byteSize += r.bytes;
    if (r.truncatedFlag) truncated.fail_dom = true;
  }
  if (inputs.lastgood_dom !== undefined) {
    const r = writeJsonSnapshot(bundleDir, 'lastgood_dom.json', inputs.lastgood_dom, DOM_TRUNCATE_BYTES);
    files.lastgood_dom = 'lastgood_dom.json';
    byteSize += r.bytes;
    if (r.truncatedFlag) truncated.lastgood_dom = true;
  }

  // --- Trace slice (JSONL, redacted per-event) ---
  if (inputs.trace_slice && inputs.trace_slice.length > 0) {
    const slicePath = path.join(bundleDir, 'trace_slice.jsonl');
    let slice = inputs.trace_slice;
    let traceTruncated = false;
    let raw = '';
    for (const ev of slice) {
      const redacted = { ...ev, body: redactValue(ev.body) };
      const line = JSON.stringify(redacted) + '\n';
      if (byteSize + raw.length + line.length > maxBytes) {
        traceTruncated = true;
        break;
      }
      raw += line;
    }
    fs.writeFileSync(slicePath, raw, 'utf8');
    files.trace_slice = 'trace_slice.jsonl';
    byteSize += Buffer.byteLength(raw, 'utf8');
    if (traceTruncated || raw.split('\n').length - 1 < slice.length) {
      truncated.trace_slice = true;
    }
  }

  // --- Manifest written last (atomic via temp + rename) ---
  const manifest: BundleManifest = {
    schema_version: 1,
    txn_id: inputs.transaction.txn_id,
    contract_id: inputs.transaction.contract_id,
    verdict: inputs.transaction.verdict,
    generated_at: Date.now(),
    files,
    transaction: inputs.transaction,
    suggested_next_steps: inputs.suggested_next_steps,
    byte_size: byteSize,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  byteSize += Buffer.byteLength(manifestText, 'utf8');
  manifest.byte_size = byteSize;

  const tmpPath = path.join(bundleDir, TMP_MANIFEST_FILENAME);
  const finalPath = path.join(bundleDir, MANIFEST_FILENAME);
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmpPath, finalPath);

  return { bundleDir, manifestPath: finalPath, byteSize };
}

/**
 * Read a bundle manifest. Returns null when the manifest does not
 * exist OR a referenced file is missing — in either case the bundle
 * is "not readable" by the atomic-write contract.
 */
export function readEvidenceBundle(
  txnId: string,
  opts: EvidenceBundleOptions = {},
): BundleManifest | null {
  const rootDir = opts.rootDir ?? defaultBundleRootDir();
  const bundleDir = path.join(rootDir, txnId);
  const manifestPath = path.join(bundleDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BundleManifest;
  } catch {
    return null;
  }
  for (const rel of Object.values(manifest.files)) {
    if (typeof rel !== 'string') continue;
    const p = path.join(bundleDir, rel);
    if (!fs.existsSync(p)) return null;
  }
  return manifest;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function writeScreenshot(
  bundleDir: string,
  filename: string,
  source: Buffer | string | undefined,
  files: BundleManifest['files'],
  key: keyof BundleManifest['files'],
  bytesSoFar: number,
  maxBytes: number,
  skipped: Array<keyof BundleManifest['files']>,
): number {
  if (source === undefined) return 0;
  let buf: Buffer;
  if (Buffer.isBuffer(source)) {
    buf = source;
  } else {
    if (!fs.existsSync(source)) return 0;
    buf = fs.readFileSync(source);
  }
  // Honor the bundle byte cap: a single oversized frame is dropped and
  // surfaced via `truncated[key]` rather than silently inflating the
  // bundle past the configured limit.
  if (bytesSoFar + buf.byteLength > maxBytes) {
    skipped.push(key);
    return 0;
  }
  fs.writeFileSync(path.join(bundleDir, filename), buf);
  files[key] = filename;
  return buf.byteLength;
}

function writeJsonSnapshot(
  bundleDir: string,
  filename: string,
  value: unknown,
  truncateBytes: number,
): { bytes: number; truncatedFlag: boolean } {
  const redacted = redactValue(value);
  const json = JSON.stringify(redacted);
  if (json.length > truncateBytes) {
    const truncated = {
      _truncated: true,
      _original_bytes: json.length,
      preview: json.slice(0, truncateBytes),
    };
    const out = JSON.stringify(truncated);
    fs.writeFileSync(path.join(bundleDir, filename), out, 'utf8');
    return { bytes: Buffer.byteLength(out, 'utf8'), truncatedFlag: true };
  }
  fs.writeFileSync(path.join(bundleDir, filename), json, 'utf8');
  return { bytes: Buffer.byteLength(json, 'utf8'), truncatedFlag: false };
}

/* ------------------------------------------------------------------ */
/* MCP resource handler                                                */
/* ------------------------------------------------------------------ */

export const TRANSACTION_URI_PREFIX = 'openchrome://transaction/';

/** Parse `openchrome://transaction/<txnId>` (no sub-paths in v1). */
export function parseTransactionUri(uri: string): string | null {
  if (!uri.startsWith(TRANSACTION_URI_PREFIX)) return null;
  const rest = uri.slice(TRANSACTION_URI_PREFIX.length);
  if (!rest || rest.includes('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  // Defend against percent-encoded traversal (e.g. `%2e%2e%2fother`):
  // `path.join(rootDir, '../...')` would escape the bundle root once we
  // hit `readEvidenceBundle`. Reject any decoded segment that contains
  // a path separator, NUL, or resolves to a `.`/`..` directory entry.
  if (
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    return null;
  }
  return decoded;
}

export async function readTransactionResource(
  uri: string,
  opts: EvidenceBundleOptions = {},
): Promise<{ mimeType: string; text: string } | null> {
  const txnId = parseTransactionUri(uri);
  if (!txnId) return null;
  const manifest = readEvidenceBundle(txnId, opts);
  if (!manifest) return null;
  return { mimeType: 'application/json', text: JSON.stringify(manifest) };
}

/**
 * Pseudo-static "list" resource for `resources/list` discoverability.
 * Returned shape mirrors the trace `list` resource.
 */
export const transactionDiscoveryHelp = {
  uri: 'openchrome://transaction/',
  hint:
    'Per-transaction evidence bundles. URI: openchrome://transaction/<txn_id>. ' +
    'Returns the bundle manifest (JSON). Bundles are written by the contract runtime ' +
    'on every settled transaction.',
};

// Defensive use of crypto so this module also doubles as a stable id helper
// for callers that need a deterministic file name fingerprint.
export function fingerprintBundle(manifest: BundleManifest): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ id: manifest.txn_id, verdict: manifest.verdict }))
    .digest('hex')
    .slice(0, 12);
}
