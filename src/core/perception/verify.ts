/**
 * Per-action verify helper (#827).
 *
 * Upgrades the legacy `verify: boolean` field on interact/act/fill_form to a
 * structured diff signal: AX-tree hash delta + 64×64 pHash distance. The
 * payload is capped at VERIFY_TOTAL_BYTES_LIMIT bytes; thumbs are dropped if
 * they would exceed the cap.
 *
 * Pure-JS only:
 *   - PNG decode: `src/contracts/png-decode.ts`
 *   - pHash:      `src/contracts/phash.ts`
 *   - PNG encode: minimal inline encoder (filter 0 + zlib deflate) — same
 *                 shape as the test fixture in tests/contracts/png-fixtures.ts.
 *
 * Portability-harness alignment (#827):
 *   - P1/P2: opt-in. mode='none' → no captures, no payload changes.
 *   - P3:    no LLM.
 *   - P4:    no `sharp`, no new deps.
 *   - P5:    no persistent storage.
 */

import { deflateSync } from 'zlib';
import { createHash } from 'crypto';
import { decodePng } from '../../contracts/png-decode';
import { hamming, phashFromPng } from '../../contracts/phash';

// ─── Public types ────────────────────────────────────────────────────────────

export type VerifyMode = 'none' | 'ax-diff' | 'screenshot' | 'both';

export interface VerifyAxReport {
  changed: boolean;
  summary: string;
  hash_before: string;
  hash_after: string;
  note?: 'ax_unavailable';
}

export interface VerifyScreenshotReport {
  phash_distance: number;
  before_thumb_png_b64: string;
  after_thumb_png_b64: string;
  skipped?: 'viewport_too_large' | 'capture_failed';
}

export interface VerifyReport {
  mode: VerifyMode;
  ax_diff?: VerifyAxReport;
  screenshot?: VerifyScreenshotReport;
  total_bytes: number;
}

/** AX node tuple used to compute the stable AX hash. */
export interface AxNodeTuple {
  role: string;
  name: string;
  /** Input/control value (textbox content, combobox selection, etc.). */
  value?: string;
  state?: string;
  focused?: boolean;
  disabled?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Hard payload ceiling for the full verify block (#827). */
export const VERIFY_TOTAL_BYTES_LIMIT = 4096;
/** Viewport pixel ceiling — captures above this skip with viewport_too_large. */
export const VERIFY_MAX_VIEWPORT_PIXELS = 4_000_000;
/** Thumb size used for pHash + payload — 64×64 is the issue's spec. */
export const VERIFY_THUMB_SIZE = 64;

// ─── Coercion ────────────────────────────────────────────────────────────────

const ENUM: ReadonlyArray<VerifyMode> = ['none', 'ax-diff', 'screenshot', 'both'];

/**
 * Backcompat shim: map the historical `verify: boolean | string | undefined`
 * input into the strict {@link VerifyMode} enum.
 *
 *   `true`               → `'screenshot'`  (legacy interact behavior)
 *   `false` | `null`     → `'none'`
 *   `undefined`          → `'none'`
 *   string in ENUM       → as-is
 *   anything else        → `'none'`        (safe default)
 */
export function coerceVerifyMode(input: unknown): VerifyMode {
  if (input === true) return 'screenshot';
  if (input === false || input === null || input === undefined) return 'none';
  if (typeof input === 'string' && (ENUM as readonly string[]).includes(input)) {
    return input as VerifyMode;
  }
  return 'none';
}

// ─── JSON Schema fragment ────────────────────────────────────────────────────

/**
 * JSON Schema fragment for the `verify` field. Accepts the legacy boolean
 * and the new string enum. Exported so each tool reuses the exact same shape.
 */
export const VERIFY_FIELD_SCHEMA = {
  oneOf: [
    { type: 'boolean' },
    { type: 'string', enum: ['none', 'ax-diff', 'screenshot', 'both'] },
  ],
  description:
    'Verify mode. boolean is legacy: true→"screenshot", false→"none". ' +
    'String enum returns a compact diff signal (AX-hash delta + pHash, ≤4KB).',
} as const;

// ─── AX hashing ──────────────────────────────────────────────────────────────

/**
 * Compute a stable AX-tree hash from a list of node tuples. The hash is
 * SHA-256 over a deterministic serialization, truncated to 16 lowercase
 * hex chars (64 bits — same width as the pHash for symmetry).
 */
export function hashAxNodes(nodes: ReadonlyArray<AxNodeTuple>): string {
  // Stable serialization: sort node tuples to be insensitive to enumeration
  // order, then join with \x1f field separators and \x1e record separators.
  const lines = nodes
    .map((n) =>
      [
        n.role || '',
        n.name || '',
        n.value || '',
        n.state || '',
        n.focused === true ? '1' : '0',
        n.disabled === true ? '1' : '0',
      ].join('\x1f'),
    )
    .sort();
  const payload = lines.join('\x1e');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Compute a one-line summary of the AX-tree delta — counts added, removed,
 * and changed (role,name) tuples. Bounded by the input lengths.
 */
export function summarizeAxDelta(
  before: ReadonlyArray<AxNodeTuple>,
  after: ReadonlyArray<AxNodeTuple>,
): string {
  const key = (n: AxNodeTuple) => `${n.role}\x1f${n.name}`;

  // Use frequency maps (not Sets) so pages with repeated controls — e.g.
  // multiple "button|Submit" nodes — count added/removed accurately. With
  // a Set, adding one and keeping the others reads as 0 added.
  const beforeCount = new Map<string, number>();
  const afterCount = new Map<string, number>();
  for (const n of before) beforeCount.set(key(n), (beforeCount.get(key(n)) ?? 0) + 1);
  for (const n of after) afterCount.set(key(n), (afterCount.get(key(n)) ?? 0) + 1);

  let added = 0;
  let removed = 0;
  const allKeys = new Set<string>([...beforeCount.keys(), ...afterCount.keys()]);
  for (const k of allKeys) {
    const b = beforeCount.get(k) ?? 0;
    const a = afterCount.get(k) ?? 0;
    if (a > b) added += a - b;
    else if (b > a) removed += b - a;
  }

  // "changed" = same (role,name) but a value/state/focused/disabled flag
  // flipped on at least one matching node. We pair before-nodes to
  // after-nodes greedily for keys present in both lists.
  const beforeBuckets = new Map<string, AxNodeTuple[]>();
  for (const n of before) {
    const k = key(n);
    const arr = beforeBuckets.get(k);
    if (arr) arr.push(n);
    else beforeBuckets.set(k, [n]);
  }
  let changed = 0;
  for (const n of after) {
    const bucket = beforeBuckets.get(key(n));
    if (!bucket || bucket.length === 0) continue;
    const b = bucket.shift()!;
    if (
      (b.value || '') !== (n.value || '') ||
      (b.state || '') !== (n.state || '') ||
      (b.focused === true) !== (n.focused === true) ||
      (b.disabled === true) !== (n.disabled === true)
    ) {
      changed++;
    }
  }

  return `${added} added, ${removed} removed, ${changed} changed`;
}

/** Snapshot the AX tree as node tuples via CDP `Accessibility.getFullAXTree`. */
async function snapshotAx(page: any): Promise<AxNodeTuple[] | null> {
  try {
    const target = page?.target?.();
    if (!target?.createCDPSession) return null;
    const session = await target.createCDPSession();
    try {
      const { nodes } = (await session.send('Accessibility.getFullAXTree')) as {
        nodes: Array<{
          role?: { value?: string };
          name?: { value?: string };
          value?: { value?: unknown };
          properties?: Array<{ name: string; value: { value?: unknown } }>;
          ignored?: boolean;
        }>;
      };
      const out: AxNodeTuple[] = [];
      for (const node of nodes || []) {
        if (node.ignored) continue;
        const role = node.role?.value || '';
        if (!role) continue;
        let state = '';
        let focused = false;
        let disabled = false;
        for (const p of node.properties || []) {
          if (p.name === 'focused' && p.value?.value === true) focused = true;
          else if (p.name === 'disabled' && p.value?.value === true) disabled = true;
          else if (p.name === 'checked' || p.name === 'selected' || p.name === 'expanded' || p.name === 'pressed') {
            // Fold all toggle-style states into a single space-joined value.
            const v = String(p.value?.value ?? '');
            if (v && v !== 'false') state += (state ? ' ' : '') + `${p.name}=${v}`;
          }
        }
        // Capture the AX value property — text inputs, combobox selections,
        // etc. Without this, typing into a textbox would not change the hash
        // when role/name/state/focused/disabled all stay constant.
        const rawValue = node.value?.value;
        const value =
          rawValue === undefined || rawValue === null ? undefined : String(rawValue);
        out.push({
          role,
          name: node.name?.value || '',
          value,
          state: state || undefined,
          focused,
          disabled,
        });
      }
      return out;
    } finally {
      try {
        await session.detach();
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null;
  }
}

// ─── PNG encode (minimal, pure-JS) ───────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Encode an 8-bit RGB pixel buffer (row-major, length = w*h*3) as a PNG.
 * Uses filter type 0 (None) and a single IDAT chunk — small images compress
 * fine without per-row filter heuristics.
 */
export function encodeRgbPng(width: number, height: number, rgb: Buffer | Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: expected ${width * height * 3} bytes, got ${rgb.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgb.subarray(y * stride, (y + 1) * stride)).copy(
      filtered,
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(filtered, { level: 9 });
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Resize (area-average to N×N) ────────────────────────────────────────────

/**
 * Area-average downsample an RGBA buffer to a square `dst` size. Drops alpha
 * because the verify thumb is purely for diff perception, not transparency
 * fidelity. Returns a tightly packed RGB buffer (length = dst*dst*3).
 */
export function downsampleRgbaToRgb(
  rgba: Uint8Array | Uint8ClampedArray | Buffer,
  srcW: number,
  srcH: number,
  dst: number,
): Buffer {
  if (rgba.length !== srcW * srcH * 4) {
    throw new Error(`downsampleRgbaToRgb: buffer length ${rgba.length} != ${srcW * srcH * 4}`);
  }
  const out = Buffer.alloc(dst * dst * 3);
  const xRatio = srcW / dst;
  const yRatio = srcH / dst;
  for (let dy = 0; dy < dst; dy++) {
    const y0 = dy * yRatio;
    const y1 = (dy + 1) * yRatio;
    const yStart = Math.floor(y0);
    const yEnd = Math.min(srcH - 1, Math.floor(y1 - Number.EPSILON));
    for (let dx = 0; dx < dst; dx++) {
      const x0 = dx * xRatio;
      const x1 = (dx + 1) * xRatio;
      const xStart = Math.floor(x0);
      const xEnd = Math.min(srcW - 1, Math.floor(x1 - Number.EPSILON));
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      for (let sy = yStart; sy <= yEnd; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = xStart; sx <= xEnd; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          const w = wx * wy;
          if (w <= 0) continue;
          const idx = (sy * srcW + sx) * 4;
          r += rgba[idx] * w;
          g += rgba[idx + 1] * w;
          b += rgba[idx + 2] * w;
          weight += w;
        }
      }
      const oi = (dy * dst + dx) * 3;
      if (weight > 0) {
        out[oi] = Math.round(r / weight);
        out[oi + 1] = Math.round(g / weight);
        out[oi + 2] = Math.round(b / weight);
      }
    }
  }
  return out;
}

/** Build a 64-px PNG thumb (RGB) from a full-size PNG buffer. */
export function thumbnailPng(
  pngBuf: Buffer,
  thumbSize: number = VERIFY_THUMB_SIZE,
): Buffer {
  const decoded = decodePng(pngBuf);
  const rgb = downsampleRgbaToRgb(decoded.rgba, decoded.width, decoded.height, thumbSize);
  return encodeRgbPng(thumbSize, thumbSize, rgb);
}

// ─── Screenshot capture ──────────────────────────────────────────────────────

interface CaptureResult {
  pngBuf?: Buffer;
  skipped?: VerifyScreenshotReport['skipped'];
}

async function captureScreenshotPng(page: any): Promise<CaptureResult> {
  // Viewport-pixel guard: bail if the capture would be huge.
  try {
    const vp = page?.viewport?.();
    if (vp && Number.isFinite(vp.width) && Number.isFinite(vp.height)) {
      if (vp.width * vp.height > VERIFY_MAX_VIEWPORT_PIXELS) {
        return { skipped: 'viewport_too_large' };
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const raw = await page.screenshot({ type: 'png', fullPage: false });
    const buf = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === 'string'
        ? Buffer.from(raw, 'base64')
        : Buffer.from(raw as ArrayBuffer);
    return { pngBuf: buf };
  } catch {
    return { skipped: 'capture_failed' };
  }
}

// ─── runVerify (main entry point) ────────────────────────────────────────────

/**
 * Wrap an `action` thunk with optional before/after verification capture.
 *
 * Returns the action's result alongside an optional {@link VerifyReport}.
 * When `mode === 'none'` the report is undefined and the surrounding code
 * is byte-identical to running `await action()` directly.
 */
export async function runVerify<T>(
  page: any,
  mode: VerifyMode,
  action: () => Promise<T>,
): Promise<{ result: T; verify: VerifyReport | undefined }> {
  if (mode === 'none') {
    const result = await action();
    return { result, verify: undefined };
  }

  const wantAx = mode === 'ax-diff' || mode === 'both';
  const wantShot = mode === 'screenshot' || mode === 'both';

  // ─── Capture BEFORE ─────────────────────────────────────────────────────
  const axBeforeP = wantAx ? snapshotAx(page) : Promise.resolve(null);
  const shotBeforeP = wantShot ? captureScreenshotPng(page) : Promise.resolve<CaptureResult>({});
  const axBefore = await axBeforeP;
  const shotBefore = await shotBeforeP;

  // ─── Action ─────────────────────────────────────────────────────────────
  const result = await action();

  // ─── Capture AFTER ──────────────────────────────────────────────────────
  const axAfterP = wantAx ? snapshotAx(page) : Promise.resolve(null);
  const shotAfterP = wantShot ? captureScreenshotPng(page) : Promise.resolve<CaptureResult>({});
  const axAfter = await axAfterP;
  const shotAfter = await shotAfterP;

  // ─── Build AX report ────────────────────────────────────────────────────
  let axReport: VerifyAxReport | undefined;
  if (wantAx) {
    if (axBefore === null || axAfter === null) {
      axReport = {
        changed: false,
        summary: '0 added, 0 removed, 0 changed',
        hash_before: '',
        hash_after: '',
        note: 'ax_unavailable',
      };
    } else {
      const hb = hashAxNodes(axBefore);
      const ha = hashAxNodes(axAfter);
      axReport = {
        changed: hb !== ha,
        summary: summarizeAxDelta(axBefore, axAfter),
        hash_before: hb,
        hash_after: ha,
      };
    }
  }

  // ─── Build screenshot report ────────────────────────────────────────────
  let shotReport: VerifyScreenshotReport | undefined;
  if (wantShot) {
    // Skip flags propagate (viewport_too_large wins over capture_failed).
    const skipped = shotBefore.skipped || shotAfter.skipped;
    if (skipped) {
      shotReport = {
        phash_distance: 0,
        before_thumb_png_b64: '',
        after_thumb_png_b64: '',
        skipped,
      };
    } else if (!shotBefore.pngBuf || !shotAfter.pngBuf) {
      shotReport = {
        phash_distance: 0,
        before_thumb_png_b64: '',
        after_thumb_png_b64: '',
        skipped: 'capture_failed',
      };
    } else {
      try {
        const hb = phashFromPng(shotBefore.pngBuf);
        const ha = phashFromPng(shotAfter.pngBuf);
        const dist = hamming(hb, ha);
        const thumbBefore = thumbnailPng(shotBefore.pngBuf).toString('base64');
        const thumbAfter = thumbnailPng(shotAfter.pngBuf).toString('base64');
        shotReport = {
          phash_distance: dist,
          before_thumb_png_b64: thumbBefore,
          after_thumb_png_b64: thumbAfter,
        };
      } catch {
        shotReport = {
          phash_distance: 0,
          before_thumb_png_b64: '',
          after_thumb_png_b64: '',
          skipped: 'capture_failed',
        };
      }
    }
  }

  // ─── Cap total payload at VERIFY_TOTAL_BYTES_LIMIT ──────────────────────
  // The size budget must account for the `total_bytes` field itself, which
  // is part of the final payload returned to callers. Measuring without
  // that field undercounts and lets the rendered VerifyReport spill over
  // VERIFY_TOTAL_BYTES_LIMIT for callers right at the ceiling.
  const measureWith = (totalBytesGuess: number): number => {
    return Buffer.byteLength(
      JSON.stringify({
        mode,
        ax_diff: axReport,
        screenshot: shotReport,
        total_bytes: totalBytesGuess,
      }),
      'utf8',
    );
  };

  // Two-step fixed-point: the JSON length of `total_bytes` itself grows
  // with the number's digit count, so we iterate until stable (bounded).
  let total = measureWith(0);
  for (let i = 0; i < 4; i++) {
    const next = measureWith(total);
    if (next === total) break;
    total = next;
  }
  if (total > VERIFY_TOTAL_BYTES_LIMIT && shotReport && !shotReport.skipped) {
    // First drop the thumbs (they dominate the payload).
    shotReport = {
      phash_distance: shotReport.phash_distance,
      before_thumb_png_b64: '',
      after_thumb_png_b64: '',
      skipped: 'capture_failed',
    };
    total = measureWith(0);
    for (let i = 0; i < 4; i++) {
      const next = measureWith(total);
      if (next === total) break;
      total = next;
    }
  }

  const report: VerifyReport = {
    mode,
    ...(axReport ? { ax_diff: axReport } : {}),
    ...(shotReport ? { screenshot: shotReport } : {}),
    total_bytes: total,
  };

  return { result, verify: report };
}
