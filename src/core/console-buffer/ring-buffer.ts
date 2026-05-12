/**
 * ConsoleRingBuffer — byte-aware O(1) circular ring buffer for console log entries.
 *
 * Invariants:
 *   1. After every push: retained <= maxLines AND retainedBytes <= maxBytes.
 *   2. Eviction is FIFO: oldest entries removed first.
 *   3. A single entry whose sizeBytes > maxBytes is stored as a truncated
 *      placeholder rather than silently dropped.
 *   4. stats().evictedTotal is monotonically non-decreasing within one lifecycle.
 *   5. clear() resets retained but preserves evictedTotal (audit signal).
 *
 * Tier: core (P1–P5 compliant — pure in-memory, no native deps, no slice realloc).
 */

import type { ConsoleRingBuffer, ConsoleRingBufferOptions, ConsoleRingBufferStats } from './types';

// Defensive env parsing — a non-numeric, NaN, negative, or zero value would
// otherwise propagate into `new Array(NaN)` / `new Float64Array(NaN)` and
// crash `console_capture start` at runtime (Codex P2). Reject anything that
// isn't a positive integer and fall back to the documented default.
function parsePositiveIntEnv(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

const DEFAULT_MAX_LINES = parsePositiveIntEnv('OPENCHROME_CONSOLE_BUFFER_MAX_LINES', 1000);
const DEFAULT_MAX_BYTES = parsePositiveIntEnv('OPENCHROME_CONSOLE_BUFFER_MAX_BYTES', 4194304);

/**
 * Create a truncated placeholder entry for an oversized push.
 * The caller is responsible for providing a typed placeholder factory.
 */
export type PlaceholderFactory<T> = (originalSizeBytes: number) => T;

class ConsoleRingBufferImpl<T> implements ConsoleRingBuffer<T> {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly placeholder: PlaceholderFactory<T>;

  // Circular buffer storage: pre-allocated to maxLines slots.
  private readonly buf: Array<T | undefined>;
  private readonly sizes: Float64Array; // per-slot byte sizes

  // _head = index of oldest entry; _tail = next write position.
  // When empty: _head === _tail.
  private _head = 0;
  private _tail = 0;
  private count = 0;
  private retainedBytes = 0;

  // Monotonically non-decreasing eviction counters (preserved across clear()).
  private evictedTotal = 0;
  private evictedBytes = 0;

  // Timestamps of first and last retained entry.
  private firstAt: number | null = null;
  private lastAt: number | null = null;

  // Timestamp accessor — entries are expected to carry a `timestamp` field
  // (ConsoleLogEntry shape). We store timestamps separately to avoid casting.
  private readonly timestamps: Float64Array;

  constructor(opts: ConsoleRingBufferOptions, placeholder: PlaceholderFactory<T>) {
    this.maxLines = opts.maxLines;
    this.maxBytes = opts.maxBytes;
    this.placeholder = placeholder;
    // Allocate capacity = maxLines slots. We track `count` directly to
    // distinguish full from empty without needing a sentinel slot.
    this.buf = new Array<T | undefined>(this.maxLines);
    this.sizes = new Float64Array(this.maxLines);
    this.timestamps = new Float64Array(this.maxLines);
  }

  push(entry: T, sizeBytes: number): void {
    // Decide what we're about to store and its accounted size.
    //   - Normal entry: stored as-is at `sizeBytes`.
    //   - Oversized entry (sizeBytes > maxBytes): replaced by a tiny
    //     placeholder accounted at 0 bytes (the placeholder IS the entry,
    //     not an eviction).
    // Both paths funnel through the same `_insertWithEviction` helper so
    // every push enforces BOTH caps before touching `_insert`. This makes
    // the line-cap invariant (count ≤ maxLines) trivially structural —
    // no separate code path can grow `count` past `maxLines`.
    const ts = this._entryTimestamp(entry);
    if (sizeBytes > this.maxBytes) {
      const ph = this.placeholder(sizeBytes);
      this._insertWithEviction(ph, 0, ts);
      return;
    }
    this._insertWithEviction(entry, sizeBytes, ts);
  }

  /**
   * Evict oldest entries until both caps would be respected after a single
   * subsequent _insert of the supplied size, then insert. Always preserves
   * `count <= maxLines` and `retainedBytes <= maxBytes` post-condition.
   */
  private _insertWithEviction(entry: T, sizeBytes: number, ts: number): void {
    while (
      this.count > 0 &&
      (this.count >= this.maxLines || this.retainedBytes + sizeBytes > this.maxBytes)
    ) {
      this._evictOldest();
    }
    this._insert(entry, sizeBytes, ts);
  }

  tail(n: number): T[] {
    if (this.count === 0 || n <= 0) return [];
    const take = Math.min(n, this.count);
    const result: T[] = new Array<T>(take);
    // Newest-last: entries from (count - take) to count-1 in insertion order.
    const startOffset = this.count - take;
    for (let i = 0; i < take; i++) {
      const idx = (this._head + startOffset + i) % this.maxLines;
      result[i] = this.buf[idx] as T;
    }
    return result;
  }

  drain(): T[] {
    if (this.count === 0) return [];
    const result: T[] = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this._head + i) % this.maxLines;
      result[i] = this.buf[idx] as T;
    }
    return result;
  }

  clear(): void {
    // Eviction counters are preserved as an audit signal. Null out the slot
    // references so retained payloads become eligible for GC immediately —
    // long-lived captures otherwise hold the previous buffer's entries
    // strongly until the slots are overwritten by future pushes (Codex P2).
    for (let i = 0; i < this.maxLines; i++) {
      this.buf[i] = undefined;
    }
    this._head = 0;
    this._tail = 0;
    this.count = 0;
    this.retainedBytes = 0;
    this.firstAt = null;
    this.lastAt = null;
  }

  stats(): ConsoleRingBufferStats {
    return {
      retained: this.count,
      retainedBytes: this.retainedBytes,
      evictedTotal: this.evictedTotal,
      evictedBytes: this.evictedBytes,
      firstEntryAt: this.firstAt,
      lastEntryAt: this.lastAt,
    };
  }

  // ---- Internal helpers ----

  private _insert(entry: T, sizeBytes: number, ts: number): void {
    this.buf[this._tail] = entry;
    this.sizes[this._tail] = sizeBytes;
    this.timestamps[this._tail] = ts;

    this._tail = (this._tail + 1) % this.maxLines;
    this.count++;
    this.retainedBytes += sizeBytes;

    // Update timestamps
    if (this.count === 1) {
      this.firstAt = ts;
    }
    this.lastAt = ts;
  }

  private _evictOldest(): void {
    if (this.count === 0) return;
    const evictedSize = this.sizes[this._head];
    this.evictedTotal++;
    this.evictedBytes += evictedSize;
    this.retainedBytes -= evictedSize;
    this.buf[this._head] = undefined; // allow GC
    this._head = (this._head + 1) % this.maxLines;
    this.count--;

    if (this.count === 0) {
      this.firstAt = null;
      this.lastAt = null;
    } else {
      // Update firstAt to next oldest entry's timestamp
      this.firstAt = this.timestamps[this._head];
    }
  }

  private _entryTimestamp(entry: T): number {
    // Best-effort: read timestamp field from the entry if present.
    if (entry !== null && typeof entry === 'object' && 'timestamp' in (entry as object)) {
      const ts = (entry as Record<string, unknown>)['timestamp'];
      if (typeof ts === 'number') return ts;
    }
    return Date.now();
  }
}

/**
 * Create a new ConsoleRingBuffer with the given options and placeholder factory.
 *
 * @param opts       Cap options (maxLines, maxBytes). Defaults use env vars.
 * @param placeholder Factory that produces a typed truncation placeholder.
 */
/**
 * Coerce a caller-supplied cap to a positive integer. Any value that would
 * crash the constructor (`0`, `NaN`, `-1`, `'abc'`, `Infinity`, non-integer)
 * silently falls back to the documented default — see Codex P1 (zero
 * `maxLines` makes the buffer's modulo arithmetic produce invalid indices
 * and the eviction loop spin forever).
 */
function sanePositiveInt(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function createConsoleRingBuffer<T>(
  opts: Partial<ConsoleRingBufferOptions>,
  placeholder: PlaceholderFactory<T>,
): ConsoleRingBuffer<T> {
  return new ConsoleRingBufferImpl<T>(
    {
      maxLines: sanePositiveInt(opts.maxLines, DEFAULT_MAX_LINES),
      maxBytes: sanePositiveInt(opts.maxBytes, DEFAULT_MAX_BYTES),
    },
    placeholder,
  );
}

export { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES };
