/**
 * In-process idempotency cache + preemptive cancellation for the pilot
 * contract runtime. Issue #791 (Phase 3 of the 1.11 cleanup), built on
 * the merged contract runtime from PR #797.
 *
 * Scope (v1):
 *   - In-memory only. Map-backed, no SQLite/persistence. A process
 *     restart correctly forces fresh executions; durable dedup is out
 *     of scope until a follow-up phase decides on a storage substrate.
 *   - Caches only `success` verdicts. A cached failure (postcondition
 *     violation, budget exhausted) would be unsafe to replay because
 *     page state may have changed between runs.
 *   - Cache key = sha256(canonicalJson({ contract_id, args })). Callers
 *     opt in by supplying an `IdempotencyCache` to `runWithContract` —
 *     the runtime no-ops when the cache argument is omitted.
 *
 * Preemptive cancellation:
 *   - Each in-flight run is registered as `(key, epoch, AbortController)`.
 *     When a new run arrives with the SAME key but a HIGHER epoch, the
 *     older run's `AbortController.abort()` fires synchronously. The
 *     epoch is a caller-supplied monotonic counter (e.g., outcome
 *     contract submission sequence) — it lets the runtime distinguish
 *     "duplicate of the in-flight call" (same epoch → return the same
 *     pending promise) from "new attempt that supersedes the in-flight
 *     call" (higher epoch → abort, run fresh).
 *
 * Flag gate:
 *   - The runtime consults `isContractRuntimeEnabled()` before consulting
 *     the cache; when the family flag is off the cache is bypassed and
 *     the runtime returns the synthetic disabled-record. The cache
 *     itself stays safe to construct so test setup does not need to
 *     branch on the flag.
 */

import * as crypto from 'node:crypto';

import type { TransactionRecord } from './types.js';

/** Default TTL for cached success verdicts (5 minutes). */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  record: TransactionRecord;
  /** Absolute timestamp (ms) when this entry stops being a valid hit. */
  expires_at: number;
}

interface InflightEntry {
  epoch: number;
  controller: AbortController;
  /** Promise resolving to the final record for this in-flight run. */
  promise: Promise<TransactionRecord>;
}

export interface IdempotencyCacheOptions {
  /** Test hook: deterministic clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Canonical JSON: keys sorted recursively. Stable across authoring order
 * so logically-equivalent payloads hash to the same cache key.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * In-process cache that stores successful contract verdicts keyed by
 * `(contract_id, args)` and tracks in-flight runs for preemptive
 * cancellation. See module header for design notes.
 */
export class IdempotencyCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly now: () => number;

  constructor(opts: IdempotencyCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Derive the cache key for a `(contractId, args)` pair. `args` is
   * canonicalised so equivalent payloads (different key order, etc.)
   * hash identically.
   */
  key(contractId: string, args?: unknown): string {
    const subject = canonicalJson({
      contract_id: contractId,
      args: args ?? null,
    });
    return crypto.createHash('sha256').update(subject).digest('hex');
  }

  /**
   * Look up a cached record. Returns `undefined` on miss or when the
   * entry has expired. Expired entries are purged lazily on read so
   * callers do not need a separate sweeper.
   */
  lookup(key: string): TransactionRecord | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires_at <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.record;
  }

  /**
   * Store a successful verdict. Callers MUST only invoke this when
   * `record.verdict === 'success'`; the cache itself enforces the
   * invariant defensively so a misuse cannot pollute the cache with a
   * replayable failure.
   */
  record(key: string, record: TransactionRecord, ttlMs: number = DEFAULT_CACHE_TTL_MS): void {
    if (record.verdict !== 'success') return;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    this.entries.set(key, {
      record,
      expires_at: this.now() + ttlMs,
    });
  }

  /**
   * Register an in-flight run. Returns the AbortSignal the runtime
   * should propagate to the skill. If an existing in-flight entry has
   * a LOWER epoch than `epoch`, it is aborted first so the older
   * superseded run settles as soon as possible.
   *
   * If an existing entry has the SAME epoch, the existing controller
   * is returned (so the runtime can choose to share a pending promise
   * — currently the runtime does not, in keeping with the "always
   * settles" simplicity, but the registry returns the same signal so
   * the duplicate caller observes the same abort behaviour).
   *
   * If an existing entry has a HIGHER epoch, the incoming run is
   * aborted immediately — it was preempted before it could start.
   */
  registerInflight(key: string, epoch: number, promise: Promise<TransactionRecord>): AbortSignal {
    const existing = this.inflight.get(key);
    if (existing) {
      if (existing.epoch < epoch) {
        // Preempt: newer attempt supersedes the in-flight run.
        existing.controller.abort();
        // Fall through to register the new controller below.
      } else if (existing.epoch > epoch) {
        // Stale arrival: abort the incoming run before it begins.
        const aborted = new AbortController();
        aborted.abort();
        return aborted.signal;
      } else {
        // Same epoch — duplicate caller. Reuse the existing signal so
        // both observers see the same abort semantics.
        return existing.controller.signal;
      }
    }
    const controller = new AbortController();
    this.inflight.set(key, { epoch, controller, promise });
    return controller.signal;
  }

  /**
   * Remove an in-flight registration. Idempotent. The runtime calls
   * this in a `finally` block so a thrown skill or settled promise
   * never strands the entry. Only clears the entry when the recorded
   * epoch matches `epoch` — a newer epoch supersedes the older one and
   * must not be erased by the older run's cleanup.
   */
  releaseInflight(key: string, epoch: number): void {
    const existing = this.inflight.get(key);
    if (!existing) return;
    if (existing.epoch !== epoch) return;
    this.inflight.delete(key);
  }

  /**
   * Explicitly cancel any in-flight run for a key. Returns true when an
   * entry was found and aborted, false otherwise. Exposed so callers
   * driving the runtime from a higher-level scheduler (e.g., a queue
   * processor that wants to discard a stale task) can preempt without
   * having to thread an epoch.
   */
  cancelInflight(key: string): boolean {
    const existing = this.inflight.get(key);
    if (!existing) return false;
    existing.controller.abort();
    this.inflight.delete(key);
    return true;
  }

  /**
   * Look up the in-flight promise for a key, if any. Used by the
   * runtime to coalesce concurrent duplicates onto the same execution.
   */
  getInflight(key: string): Promise<TransactionRecord> | undefined {
    return this.inflight.get(key)?.promise;
  }

  /** Number of cached entries — exposed for diagnostics + tests. */
  size(): number {
    return this.entries.size;
  }

  /** Drop every entry — exposed for tests + diagnostics. */
  clear(): void {
    this.entries.clear();
    // Abort every in-flight controller so any awaiters settle.
    for (const entry of this.inflight.values()) {
      entry.controller.abort();
    }
    this.inflight.clear();
  }
}
