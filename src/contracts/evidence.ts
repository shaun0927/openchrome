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
      | 'lastgood_screenshot'
      | 'manifest',
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
  // Effective per-DOM cap is min(DOM_TRUNCATE_BYTES, remaining bundle
  // budget). Without this, a 50 KB-configured bundle could still hold
  // two 500 KB DOM payloads because the per-DOM cap was the only check.
  if (inputs.fail_dom !== undefined) {
    const cap = Math.min(DOM_TRUNCATE_BYTES, Math.max(0, maxBytes - byteSize));
    const r = writeJsonSnapshot(bundleDir, 'fail_dom.json', inputs.fail_dom, cap);
    files.fail_dom = 'fail_dom.json';
    byteSize += r.bytes;
    if (r.truncatedFlag) truncated.fail_dom = true;
  }
  if (inputs.lastgood_dom !== undefined) {
    const cap = Math.min(DOM_TRUNCATE_BYTES, Math.max(0, maxBytes - byteSize));
    const r = writeJsonSnapshot(bundleDir, 'lastgood_dom.json', inputs.lastgood_dom, cap);
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
    let rawBytes = 0;
    for (const ev of slice) {
      const redacted = { ...ev, body: redactValue(ev.body) };
      const line = JSON.stringify(redacted) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf8');
      // Use UTF-8 byte length: `raw.length` is UTF-16 code units, so a
      // payload full of CJK / emoji could pass this check while the
      // on-disk file blows past the cap by 50%+.
      if (byteSize + rawBytes + lineBytes > maxBytes) {
        traceTruncated = true;
        break;
      }
      raw += line;
      rawBytes += lineBytes;
    }
    fs.writeFileSync(slicePath, raw, 'utf8');
    files.trace_slice = 'trace_slice.jsonl';
    byteSize += rawBytes;
    if (traceTruncated || raw.split('\n').length - 1 < slice.length) {
      truncated.trace_slice = true;
    }
  }

  // --- Manifest written last (atomic via temp + rename) ---
  // The TransactionRecord may carry URLs / args / response snippets that
  // contain credentials (Authorization tokens, password params, API
  // keys). DOM and trace payloads already flow through redactValue at
  // their write boundary; the manifest must do the same so the bundle
  // can't leak via the manifest itself even though every other path is
  // scrubbed.
  const redactedTransaction = redactValue(inputs.transaction) as TransactionRecord;
  let redactedNextSteps = inputs.suggested_next_steps
    ? (redactValue(inputs.suggested_next_steps) as EvidenceBundleInputs['suggested_next_steps'])
    : undefined;
  const buildManifest = (): BundleManifest => ({
    schema_version: 1,
    txn_id: redactedTransaction.txn_id,
    contract_id: redactedTransaction.contract_id,
    verdict: redactedTransaction.verdict,
    generated_at: Date.now(),
    files,
    transaction: redactedTransaction,
    suggested_next_steps: redactedNextSteps,
    byte_size: byteSize,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
  });
  let manifest = buildManifest();
  let manifestBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8');
  // Manifest is mandatory (it's the index), but on a tight `maxBytes`
  // even a redacted TransactionRecord can shove the total past the
  // ceiling. Drop the largest optional field — `suggested_next_steps`
  // — first, then surface a `manifest` truncation flag so readers see
  // the bundle was abridged.
  if (byteSize + manifestBytes > maxBytes && redactedNextSteps !== undefined) {
    redactedNextSteps = undefined;
    (truncated as Record<string, true>).manifest = true;
    manifest = buildManifest();
    manifestBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8');
  }
  // `byte_size` is self-referential: writing it grows the manifest by
  // the digit count of the new value, which would make the recorded
  // size lag the actual on-disk bytes. Iterate to a fixpoint (bounded
  // since each step changes only the digit count of `byte_size`).
  let prevManifestBytes = -1;
  let iterations = 0;
  while (manifestBytes !== prevManifestBytes && iterations < 4) {
    prevManifestBytes = manifestBytes;
    manifest.byte_size = byteSize + manifestBytes;
    manifestBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8');
    iterations++;
  }
  byteSize += manifestBytes;
  manifest.byte_size = byteSize;
  const manifestText = JSON.stringify(manifest, null, 2);

  const tmpPath = path.join(bundleDir, TMP_MANIFEST_FILENAME);
  const finalPath = path.join(bundleDir, MANIFEST_FILENAME);
  fs.writeFileSync(tmpPath, manifestText, 'utf8');
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
  // Guard malformed manifests (manual tamper, partial write that
  // somehow survived, version skew). Treat unexpected shapes as
  // "not readable" — same outcome as a missing referenced file —
  // rather than crashing inside `Object.values`.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return null;
  }
  if (
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
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
  // truncateBytes is the on-disk byte budget; compare against UTF-8
  // length so a CJK / emoji-heavy DOM can't pass the check (because
  // `json.length` is UTF-16 code units) while the rendered file is
  // 2-3x larger.
  const jsonBytes = Buffer.byteLength(json, 'utf8');
  if (jsonBytes > truncateBytes) {
    // The on-disk file is the rendered wrapper, so size that output
    // — not the raw preview — against `truncateBytes`. Two effects to
    // account for:
    //   (a) wrapper overhead (~50 bytes for `{"_truncated":..."preview":""}`)
    //   (b) JSON re-escaping inside `preview`: a payload byte like `"`
    //       or `\` doubles in size when re-stringified, control chars
    //       grow to 6 bytes (`\u00xx`). A naive `truncateBytes -
    //       wrapperOverhead` budget overshoots whenever the preview
    //       contains such characters.
    // Rather than reason about worst-case escaping, render the wrapper
    // and shrink the preview byte by byte until the output fits. The
    // tail is sliced on a UTF-8 byte boundary so multibyte sequences
    // are not split mid-character.
    const previewBuffer = Buffer.from(json, 'utf8');
    const buildOut = (sliceLen: number): string => {
      const previewBytes = previewBuffer.slice(0, sliceLen);
      return JSON.stringify({
        _truncated: true,
        _original_bytes: jsonBytes,
        preview: previewBytes.toString('utf8'),
      });
    };
    let lo = 0;
    let hi = previewBuffer.length;
    // Binary-search the largest preview slice whose rendered wrapper
    // is ≤ truncateBytes. Bounded by log2(buffer_length) iterations.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const rendered = Buffer.byteLength(buildOut(mid), 'utf8');
      if (rendered <= truncateBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const out = buildOut(lo);
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
  // Discovery URI (`openchrome://transaction/` with no txn_id) returns
  // the static help payload so the static list entry has matching
  // read content. parseTransactionUri rejects empty rest deliberately;
  // handle the bare-prefix case before delegating.
  if (uri === TRANSACTION_URI_PREFIX) {
    return {
      mimeType: 'application/json',
      text: JSON.stringify(transactionDiscoveryHelp),
    };
  }
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

/**
 * Static resource definition that surfaces the `openchrome://transaction/`
 * prefix in `resources/list` so MCP clients can discover the URI scheme
 * without already knowing a `txn_id`. Mirrors the `traceListResource`
 * pattern: list URI is static + discoverable, dynamic per-bundle URIs
 * land via the prefix handler.
 */
export const transactionListResource = {
  uri: 'openchrome://transaction/',
  name: 'transaction-list',
  description:
    'Per-transaction evidence bundles. URI scheme: openchrome://transaction/<txn_id>. ' +
    'Returns the bundle manifest (JSON) for that transaction. Bundles are written by ' +
    'the contract runtime on every settled transaction.',
  mimeType: 'application/json',
} as const;

// Defensive use of crypto so this module also doubles as a stable id helper
// for callers that need a deterministic file name fingerprint.
export function fingerprintBundle(manifest: BundleManifest): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ id: manifest.txn_id, verdict: manifest.verdict }))
    .digest('hex')
    .slice(0, 12);
}
