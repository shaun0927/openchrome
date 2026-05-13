/**
 * Handle Store — atomic JSONL/blob persistence for output handles.
 *
 * Layout under baseDir (default ~/.openchrome/output/):
 *   <baseDir>/<YYYY-MM-DD>/<output_handle>.json   — JSON payloads
 *   <baseDir>/<YYYY-MM-DD>/<output_handle>.bin    — binary/gzip payloads
 *
 * TTL eviction: purgeExpired() removes files whose stored expires_at
 * is in the past. DiskMonitor calls pruneOutputDir() on each sweep tick
 * (see src/index.ts). Handles are written atomically via writeFileAtomicSafe.
 *
 * P2 compliance: all callers pass output_mode='inline' by default — the
 * store is only touched when a handle is explicitly requested.
 * P3 compliance: no new native deps; plain fs + existing atomic-file util.
 * P5 compliance: no new package.json dependencies.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { writeFileAtomicSafe } from '../../utils/atomic-file';
import type { OutputHandle, OutputHandleResponse } from './handle-store.types';

export type { OutputHandle, OutputHandleResponse };

export interface HandleMeta {
  output_handle: OutputHandle;
  mime_type: 'application/json' | 'application/gzip' | 'text/markdown';
  size_bytes: number;
  item_count: number | null;
  preview: string | null;
  expires_at: string;
  fetch_with: 'oc_output_fetch';
  /** Absolute path of the payload file on disk. */
  file_path: string;
  /** Whether payload is JSON (items) or binary (bytes). */
  payload_type: 'json' | 'binary';
}

export interface WriteHandleOptions {
  /** TTL in hours (default: 24). */
  ttlHours?: number;
  /** Source tool name (for journal event). */
  sourceTool?: string;
}

export interface FetchHandleOptions {
  offset?: number;
  limit?: number;
  format?: 'bytes' | 'items' | 'auto';
}

type NonItemFetchHandleOptions = Omit<FetchHandleOptions, 'format'> & {
  format?: 'bytes' | 'auto';
};
type ItemFetchHandleOptions = Omit<FetchHandleOptions, 'format'> & {
  format: 'items';
};

export interface FetchHandleResult {
  output_handle: OutputHandle;
  offset: number;
  limit: number;
  returned: number;
  total: number;
  next_offset: number | null;
  content: unknown[] | string;
  eof: boolean;
}

/**
 * Returned by fetch() when the caller requested format:'items' but the stored
 * payload is not a JSON array. Distinct from null (not-found) so the tool can
 * surface INVALID_FORMAT_FOR_PAYLOAD without conflating it with expiry.
 */
export interface FetchHandleFormatError {
  error: 'INVALID_FORMAT_FOR_PAYLOAD';
  handle_id: OutputHandle;
  detail: string;
}

export interface HandleStoreOptions {
  baseDir?: string;
}

const DEFAULT_TTL_HOURS = 24;
const PREVIEW_MAX_BYTES = 2048;
const DEFAULT_ITEM_LIMIT = 200;
const DEFAULT_BYTE_LIMIT = 65536;
const HANDLE_ID_RE = /^oh_[A-Z2-7]{12}$/;

/** Crockford base32 alphabet (uppercase, no I/L/O/U) — 5 bits per char */
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateHandleId(): OutputHandle {
  // 12 base32 chars = 60 bits of randomness — collision probability negligible
  const bytes = crypto.randomBytes(8);
  let n = BigInt('0x' + bytes.toString('hex'));
  let result = '';
  for (let i = 0; i < 12; i++) {
    result = BASE32_CHARS[Number(n & BigInt(31))] + result;
    n >>= BigInt(5);
  }
  return `oh_${result}` as OutputHandle;
}

function todayDir(baseDir: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(baseDir, date);
}

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.openchrome', 'output');
}

function buildPreview(payload: string | Buffer): string | null {
  if (Buffer.isBuffer(payload)) {
    // Binary: no text preview
    return null;
  }
  // UTF-8 text: return up to PREVIEW_MAX_BYTES bytes
  const buf = Buffer.from(payload, 'utf8');
  if (buf.byteLength <= PREVIEW_MAX_BYTES) return payload;
  return buf.subarray(0, PREVIEW_MAX_BYTES).toString('utf8');
}

export class HandleStore {
  private readonly baseDir: string;

  constructor(opts?: HandleStoreOptions) {
    this.baseDir = opts?.baseDir ?? defaultBaseDir();
  }

  /**
   * Write a JSON payload to storage and return the handle descriptor.
   * The payload must be a JSON-serialisable value.
   */
  async writeJson(
    payload: unknown,
    opts?: WriteHandleOptions,
  ): Promise<HandleMeta> {
    const handle = generateHandleId();
    const ttlHours = opts?.ttlHours ?? DEFAULT_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

    const dir = todayDir(this.baseDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${handle}.json`);

    const serialized = JSON.stringify(payload);
    await writeFileAtomicSafe(filePath, serialized);

    const sizeBytes = Buffer.byteLength(serialized, 'utf8');
    const itemCount = Array.isArray(payload) ? payload.length : null;
    const preview = buildPreview(serialized);

    return {
      output_handle: handle,
      mime_type: 'application/json',
      size_bytes: sizeBytes,
      item_count: itemCount,
      preview,
      expires_at: expiresAt,
      fetch_with: 'oc_output_fetch',
      file_path: filePath,
      payload_type: 'json',
    };
  }

  /**
   * Write a binary/text payload (Buffer or string) to storage.
   */
  async writeBinary(
    payload: Buffer | string,
    mimeType: 'application/gzip' | 'text/markdown',
    opts?: WriteHandleOptions,
  ): Promise<HandleMeta> {
    const handle = generateHandleId();
    const ttlHours = opts?.ttlHours ?? DEFAULT_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

    const dir = todayDir(this.baseDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const ext = mimeType === 'application/gzip' ? '.bin' : '.md';
    const filePath = path.join(dir, `${handle}${ext}`);

    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    await writeFileAtomicSafe(filePath, buf);

    const preview = buildPreview(payload);

    return {
      output_handle: handle,
      mime_type: mimeType,
      size_bytes: buf.byteLength,
      item_count: null,
      preview,
      expires_at: expiresAt,
      fetch_with: 'oc_output_fetch',
      file_path: filePath,
      payload_type: 'binary',
    };
  }

  /**
   * Fetch a handle's content with offset/limit pagination.
   * Returns null if the handle does not exist or has expired.
   * Returns FetchHandleFormatError when format:'items' is requested but the
   * stored payload is not a JSON array (P2 fix #887 — never silently falls back).
   */
  fetch(handle: OutputHandle, opts?: NonItemFetchHandleOptions): FetchHandleResult | null;
  fetch(handle: OutputHandle, opts: ItemFetchHandleOptions): FetchHandleResult | FetchHandleFormatError | null;
  fetch(handle: OutputHandle, opts?: FetchHandleOptions): FetchHandleResult | FetchHandleFormatError | null {
    const meta = this.resolveHandle(handle);
    if (!meta) return null;

    // Check expiry
    if (Date.now() > new Date(meta.expires_at).getTime()) return null;

    const offset = opts?.offset ?? 0;
    const format = opts?.format ?? 'auto';

    if (meta.payload_type === 'json') {
      // Item-based pagination
      let raw: string;
      try {
        raw = fs.readFileSync(meta.file_path, 'utf8');
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }

      // P2 fix (#887): format:'items' on a non-array payload must be rejected
      // explicitly — never silently fall back to byte pagination.
      if (format === 'items' && !Array.isArray(parsed)) {
        return {
          error: 'INVALID_FORMAT_FOR_PAYLOAD',
          handle_id: handle,
          detail:
            'format:"items" requires the stored payload to be a JSON array. ' +
            'Use format:"bytes" or format:"auto" to page through non-array payloads.',
        };
      }

      const useItems = format === 'items' || (format === 'auto' && Array.isArray(parsed));

      if (useItems && Array.isArray(parsed)) {
        const limit = opts?.limit ?? DEFAULT_ITEM_LIMIT;
        const total = parsed.length;
        const slice = parsed.slice(offset, offset + limit);
        const returned = slice.length;
        const eof = offset + returned >= total;
        return {
          output_handle: handle,
          offset,
          limit,
          returned,
          total,
          next_offset: eof ? null : offset + returned,
          content: slice,
          eof,
        };
      }

      // JSON but not array — return as bytes
      const buf = Buffer.from(raw, 'utf8');
      const limit = opts?.limit ?? DEFAULT_BYTE_LIMIT;
      const total = buf.byteLength;
      const slice = buf.subarray(offset, offset + limit);
      const returned = slice.byteLength;
      const eof = offset + returned >= total;
      return {
        output_handle: handle,
        offset,
        limit,
        returned,
        total,
        next_offset: eof ? null : offset + returned,
        content: slice.toString('base64'),
        eof,
      };
    }

    // Binary — byte-range
    let buf: Buffer;
    try {
      buf = fs.readFileSync(meta.file_path);
    } catch {
      return null;
    }
    const limit = opts?.limit ?? DEFAULT_BYTE_LIMIT;
    const total = buf.byteLength;
    const slice = buf.subarray(offset, offset + limit);
    const returned = slice.byteLength;
    const eof = offset + returned >= total;
    return {
      output_handle: handle,
      offset,
      limit,
      returned,
      total,
      next_offset: eof ? null : offset + returned,
      content: slice.toString('base64'),
      eof,
    };
  }

  /**
   * Purge all handle files whose expires_at timestamp is in the past.
   * Returns the number of files deleted.
   */
  purgeExpired(): number {
    let purged = 0;
    const now = Date.now();

    let dateDirs: string[];
    try {
      dateDirs = fs.readdirSync(this.baseDir);
    } catch {
      return 0;
    }

    for (const dateDir of dateDirs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
      const fullDir = path.join(this.baseDir, dateDir);
      let files: string[];
      try {
        files = fs.readdirSync(fullDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('oh_') || file.endsWith('.meta.json')) continue;
        const filePath = path.join(fullDir, file);
        // Read meta from handle name: we store expiry in a sidecar .meta.json
        const metaPath = filePath.replace(/\.(json|bin|md)$/, '.meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { expires_at: string };
            if (new Date(meta.expires_at).getTime() <= now) {
              fs.unlinkSync(filePath);
              fs.unlinkSync(metaPath);
              purged++;
            }
          } catch {
            // Corrupted meta — skip
          }
        }
      }
      // Remove empty date directories
      try {
        const remaining = fs.readdirSync(fullDir);
        if (remaining.length === 0) fs.rmdirSync(fullDir);
      } catch {
        // best-effort
      }
    }
    return purged;
  }

  /**
   * Resolve a handle string to its on-disk metadata by scanning the output dir.
   * We store a <handle>.meta.json alongside the payload.
   */
  private resolveHandle(handle: OutputHandle): HandleMeta | null {
    if (typeof handle !== 'string' || !HANDLE_ID_RE.test(handle)) return null;
    // Scan date subdirs (typically only 1-2 exist)
    let dateDirs: string[];
    try {
      dateDirs = fs.readdirSync(this.baseDir);
    } catch {
      return null;
    }

    for (const dateDir of dateDirs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;
      const metaPath = path.join(this.baseDir, dateDir, `${handle}.meta.json`);
      if (fs.existsSync(metaPath)) {
        try {
          return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as HandleMeta;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Write a handle meta file alongside the payload.
   * Called internally after writeJson/writeBinary.
   */
  async saveMeta(meta: HandleMeta): Promise<void> {
    const metaPath = meta.file_path.replace(/\.(json|bin|md)$/, '.meta.json');
    await writeFileAtomicSafe(metaPath, JSON.stringify(meta, null, 2));
  }
}

/** Process-global singleton */
let _instance: HandleStore | null = null;
let _instanceTtlHours = DEFAULT_TTL_HOURS;

/**
 * Replace the process-global singleton with a test-isolated instance.
 * Only intended for use in tests — not exported in production bundles,
 * but accessible via dynamic import + property access.
 * @internal
 */
export function _setInstanceForTest(store: HandleStore): void {
  _instance = store;
}

export function getHandleStore(): HandleStore {
  if (!_instance) {
    _instance = new HandleStore();
  }
  return _instance;
}

export function getDefaultTtlHours(): number {
  return _instanceTtlHours;
}

export function setDefaultTtlHours(hours: number): void {
  _instanceTtlHours = hours;
}

/**
 * Write a JSON payload to the global handle store and return the
 * OutputHandleResponse descriptor ready to return from a tool.
 */
export async function writeOutputHandle(
  payload: unknown,
  sourceTool: string,
  opts?: { ttlHours?: number },
): Promise<OutputHandleResponse> {
  const store = getHandleStore();
  const ttlHours = opts?.ttlHours ?? _instanceTtlHours;
  const meta = await store.writeJson(payload, { ttlHours, sourceTool });
  await store.saveMeta(meta);
  return {
    output_handle: meta.output_handle,
    mime_type: meta.mime_type,
    size_bytes: meta.size_bytes,
    item_count: meta.item_count,
    preview: meta.preview,
    expires_at: meta.expires_at,
    fetch_with: 'oc_output_fetch',
  };
}
