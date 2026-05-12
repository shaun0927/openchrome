/**
 * In-memory handoff registry (Phase 3, issue #793).
 *
 * Tracks tokens minted by {@link createHandoffToken} so a receiving agent
 * can redeem one and inherit the originating session's scope. Pure
 * in-memory: process restart drops every active handoff. Persistence
 * (`handoff.json` + keychain / AES-256-GCM at rest) is issue #794.
 *
 * Lifecycle:
 *
 *   register(payload) -> { token, expiresAt }
 *     mint a fresh token, store it. Replacing an existing token for the
 *     same sessionId rotates and invalidates the old one (single-use).
 *
 *   redeem(token) -> HandoffRedemption | null
 *     look up by token, verify TTL, and *remove* the record on success.
 *     null when the token is unknown, expired, or already redeemed.
 *
 *   revoke(token) -> boolean
 *     operator-initiated cancel. Returns true iff a record was removed.
 *
 *   pruneExpired() -> number
 *     drop every record past `expiresAt`. Returns the count removed.
 *
 * Periodic prune runs via `setInterval` + `.unref()` so it never keeps
 * the event loop alive on its own. Hosts that prefer explicit control
 * can pass `pruneIntervalMs: 0` to disable the timer and call
 * {@link HandoffManager.pruneExpired} manually.
 */

import { createHandoffToken, type CreateHandoffTokenArgs, type HandoffTokenResult } from './token.js';

export interface HandoffPayload {
  /** Session being transferred. */
  sessionId: string;
  /** Scope label surfaced back to the redeeming agent. */
  scope: string;
  /** Optional explicit TTL in ms (falls back to the token default). */
  ttlMs?: number;
}

export interface HandoffRecord {
  sessionId: string;
  scope: string;
  token: string;
  /** Wall-clock ms (epoch) at which the token becomes invalid. */
  expiresAt: number;
  /** Wall-clock ms at which `register()` returned. */
  createdAt: number;
}

/** Successful redemption surface — strips the token from the record. */
export interface HandoffRedemption {
  sessionId: string;
  scope: string;
  expiresAt: number;
  createdAt: number;
  /** Wall-clock ms at which {@link HandoffManager.redeem} returned ok. */
  redeemedAt: number;
}

export interface HandoffManagerOptions {
  /**
   * Periodic prune cadence in ms. Default 60s. Pass 0 to disable the
   * background timer entirely — callers may prefer to drive prune from
   * their own scheduler (e.g. on every register/redeem).
   */
  pruneIntervalMs?: number;
  /** Test hook: clock override. */
  now?: () => number;
  /** Test hook: replaceable token minter. */
  mintToken?: (args: CreateHandoffTokenArgs) => HandoffTokenResult;
}

const DEFAULT_PRUNE_INTERVAL_MS = 60 * 1000;

/**
 * In-memory store of active handoffs.
 *
 * Two indices are maintained so `redeem(token)` is O(1) without scanning
 * every record:
 *   - `bySession` (sessionId -> HandoffRecord) is the canonical store.
 *   - `byToken` (token -> sessionId) lets `redeem` and `revoke` resolve
 *     by token without exposing the session as a side-channel.
 *
 * Both indices are mutated together inside a single synchronous block —
 * no awaits between, so the pair stays consistent for the single-process
 * case. Cross-process safety is #794's responsibility.
 */
export class HandoffManager {
  private readonly bySession = new Map<string, HandoffRecord>();
  private readonly byToken = new Map<string, string>();
  private readonly now: () => number;
  private readonly mintToken: (args: CreateHandoffTokenArgs) => HandoffTokenResult;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: HandoffManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.mintToken = opts.mintToken ?? createHandoffToken;
    const interval = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        try {
          this.pruneExpired();
        } catch {
          // best-effort — a pruning hiccup must not crash the host
        }
      }, interval);
      // Never let the prune timer pin the event loop alive on its own.
      // Available on Node Timers; the guarded cast keeps DOM-typed
      // builds happy in non-Node hosts that import the type only.
      const t = this.timer as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
  }

  /**
   * Mint a token for `payload` and store it. If a record already exists
   * for the same sessionId, the previous token is invalidated (rotated)
   * before the new one is installed — there is at most one active token
   * per session.
   */
  register(payload: HandoffPayload): HandoffTokenResult {
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      throw new Error('HandoffManager.register: sessionId is required');
    }
    if (typeof payload.scope !== 'string' || payload.scope.length === 0) {
      throw new Error('HandoffManager.register: scope is required');
    }
    // Rotate: drop any prior record for this session.
    const prior = this.bySession.get(payload.sessionId);
    if (prior) {
      this.byToken.delete(prior.token);
      this.bySession.delete(prior.sessionId);
    }
    const result = this.mintToken({
      sessionId: payload.sessionId,
      scope: payload.scope,
      ttlMs: payload.ttlMs,
      now: this.now,
    });
    const record: HandoffRecord = {
      sessionId: payload.sessionId,
      scope: payload.scope,
      token: result.token,
      expiresAt: result.expiresAt,
      createdAt: this.now(),
    };
    this.bySession.set(record.sessionId, record);
    this.byToken.set(record.token, record.sessionId);
    return { token: result.token, expiresAt: result.expiresAt };
  }

  /**
   * Look up a token, verify TTL, and consume the record on success.
   * Returns null when the token is unknown, expired, or already redeemed.
   * Expired records are also removed as a side effect so subsequent calls
   * with the same (now-stale) token return null without lingering state.
   */
  redeem(token: string): HandoffRedemption | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const sessionId = this.byToken.get(token);
    if (sessionId === undefined) return null;
    const record = this.bySession.get(sessionId);
    if (record === undefined) {
      // Index drift — clean up the orphan token entry defensively.
      this.byToken.delete(token);
      return null;
    }
    const now = this.now();
    if (now >= record.expiresAt) {
      this.byToken.delete(token);
      this.bySession.delete(sessionId);
      return null;
    }
    // Consume on success. Single-use: subsequent redeem(token) returns null.
    this.byToken.delete(token);
    this.bySession.delete(sessionId);
    return {
      sessionId: record.sessionId,
      scope: record.scope,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      redeemedAt: now,
    };
  }

  /**
   * Operator-initiated revoke. Returns true iff a record was removed.
   * Idempotent — calling revoke on an unknown token returns false rather
   * than throwing.
   */
  revoke(token: string): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const sessionId = this.byToken.get(token);
    if (sessionId === undefined) return false;
    this.byToken.delete(token);
    this.bySession.delete(sessionId);
    return true;
  }

  /**
   * Drop every record whose `expiresAt` is in the past. Returns the
   * count removed. Safe to call frequently — both indices are walked
   * synchronously so there are no await boundaries to interleave with
   * register/redeem.
   */
  pruneExpired(): number {
    const now = this.now();
    let purged = 0;
    for (const [sessionId, record] of this.bySession.entries()) {
      if (now >= record.expiresAt) {
        this.byToken.delete(record.token);
        this.bySession.delete(sessionId);
        purged += 1;
      }
    }
    return purged;
  }

  /**
   * Snapshot of currently-active records. Useful for diagnostics; copies
   * the underlying records so callers cannot mutate the internal map.
   */
  list(): HandoffRecord[] {
    return [...this.bySession.values()].map((r) => ({ ...r }));
  }

  /** Number of currently-active records. */
  size(): number {
    return this.bySession.size;
  }

  /**
   * Cancel the periodic prune timer without clearing stored records.
   * Useful when the caller wants to drive pruning manually via
   * {@link pruneExpired} on its own schedule.
   * Returns true iff a timer was running and has been cancelled.
   */
  stopPrune(): boolean {
    if (this.timer === undefined) return false;
    clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  /**
   * Tear down the prune timer and drop every stored record. Hosts should
   * call this when shutting down to release the timer immediately — the
   * `.unref()` on construction means it would not block exit, but
   * explicit cleanup keeps long-lived test processes from leaking timers.
   */
  dispose(): void {
    this.stopPrune();
    this.bySession.clear();
    this.byToken.clear();
  }
}
