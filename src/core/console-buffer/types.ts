/**
 * Types for the byte-aware console ring buffer.
 * Tier: core (P1–P5 compliant — pure in-memory data structure, no native deps).
 */

export interface ConsoleRingBufferOptions {
  /** Hard cap on retained entries. Default 1000 (matches legacy maxLogs default). */
  maxLines: number;
  /** Hard cap on aggregate byte size of retained entries (JSON.stringify length).
   *  Default 4 * 1024 * 1024 (4 MiB). */
  maxBytes: number;
}

export interface ConsoleRingBufferStats {
  retained: number;
  retainedBytes: number;
  evictedTotal: number;
  evictedBytes: number;
  firstEntryAt: number | null;
  lastEntryAt: number | null;
}

export interface ConsoleRingBuffer<T> {
  push(entry: T, sizeBytes: number): void;
  /** Returns the last `n` entries newest-last (mirroring slice(-n)). */
  tail(n: number): T[];
  /** Returns all retained entries in insertion order. */
  drain(): T[];
  clear(): void;
  stats(): ConsoleRingBufferStats;
}
