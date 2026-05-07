/**
 * In-memory handoff state manager (PR-14 happy path).
 *
 * Per #708 v2:
 *   - 30-min default per-handoff timeout (`OPENCHROME_HANDOFF_TIMEOUT_MS`).
 *   - Max 3 handoffs per transaction (`OPENCHROME_HANDOFF_MAX_PER_TXN`).
 *   - Tokens rotated on every new attempt — old token is single-use and
 *     becomes invalid the moment a new one is generated.
 *
 * Persistence (`handoff.json`, OS keychain, Linux AES-256-GCM) is
 * deferred to PR-15. This module's state is in-memory only; a process
 * restart loses every active handoff. A persistence-backed subclass
 * will land in PR-15 and slot in via the same public API.
 */

import type { PersistenceAdapter } from './persistence';
import { generateHandoffToken } from './token';

export type HandoffEscalationReason =
  | 'manual_pause'
  | 'login_required'
  | 'two_factor'
  | 'fraud_review'
  | 'captcha_challenge'
  | 'identity_verification'
  | 'unknown';

export type HandoffStatus = 'pending' | 'resumed' | 'expired' | 'aborted';

export interface HandoffRecord {
  txn_id: string;
  /** Sequence number (1-based) — rotates the token each attempt. */
  attempt: number;
  /** Currently-valid token. Rotated when a new attempt is created. */
  token: string;
  status: HandoffStatus;
  reason: HandoffEscalationReason;
  summary: string;
  details?: string;
  created_at: number;
  expires_at: number;
  resumed_at?: number;
  /**
   * Wall-clock at which `status` last moved out of `pending`. Used as
   * the GC reference so retention is "24h after the handoff actually
   * ended", independent of how long `OPENCHROME_HANDOFF_TIMEOUT_MS` was
   * configured.
   */
  terminated_at?: number;
  /** Last URL the runtime asked the user to look at. */
  last_known_url?: string;
}

export interface CreateHandoffArgs {
  txn_id: string;
  reason: HandoffEscalationReason;
  summary: string;
  details?: string;
  last_known_url?: string;
}

export interface HandoffManagerOptions {
  /** Per-handoff TTL in ms. Default 30 min. */
  timeoutMs?: number;
  /** Max attempts per transaction. Default 3. */
  maxPerTxn?: number;
  /** Test hook: clock. */
  now?: () => number;
  /**
   * Optional persistence adapter (PR-15). When supplied, the manager
   * loads previously-stored records on construction and persists after
   * every mutation. When omitted, behavior is identical to PR-14 —
   * fully in-memory, lost on process restart.
   */
  persistence?: PersistenceAdapter;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PER_TXN = 3;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ResumeResult {
  ok: boolean;
  /** Reason a resume was rejected (when ok is false). */
  reason?: 'unknown_txn' | 'expired' | 'wrong_token' | 'wrong_status';
  record?: HandoffRecord;
}

/**
 * In-memory store of active handoffs. Threadsafe for the single-process
 * case (no internal mutations across awaits). Not safe across processes
 * — that's PR-15's responsibility.
 */
export class HandoffManager {
  private readonly timeoutMs: number;
  private readonly maxPerTxn: number;
  private readonly now: () => number;
  private readonly persistence?: PersistenceAdapter;
  /** Map<txn_id, HandoffRecord>. The latest attempt wins. */
  private readonly active = new Map<string, HandoffRecord>();
  /** attempt counter per txn so we can refuse a 4th call. */
  private readonly attempts = new Map<string, number>();

  constructor(opts: HandoffManagerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? envInt('OPENCHROME_HANDOFF_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.maxPerTxn = opts.maxPerTxn ?? envInt('OPENCHROME_HANDOFF_MAX_PER_TXN', DEFAULT_MAX_PER_TXN);
    this.now = opts.now ?? Date.now;
    this.persistence = opts.persistence;
    // Restore prior state — pending handoffs whose deadline still lies
    // ahead are resumable; everything else stays as a record so we can
    // honor the per-txn cap across restarts.
    if (this.persistence) {
      for (const r of this.persistence.loadAll()) {
        this.active.set(r.txn_id, r);
        this.attempts.set(r.txn_id, Math.max(this.attempts.get(r.txn_id) ?? 0, r.attempt));
      }
    }
  }

  private flush(): void {
    if (!this.persistence) return;
    try {
      this.persistence.saveAll([...this.active.values()]);
    } catch {
      // best-effort; in-memory state stays consistent regardless
    }
  }

  /**
   * Begin a new handoff (or rotate the token for an existing one).
   * Throws when the per-txn cap is exhausted.
   */
  create(args: CreateHandoffArgs): HandoffRecord {
    const prevAttempts = this.attempts.get(args.txn_id) ?? 0;
    if (prevAttempts >= this.maxPerTxn) {
      throw new Error(
        `handoff cap exhausted for txn ${args.txn_id}: ${prevAttempts} attempts >= ${this.maxPerTxn}`,
      );
    }
    const attempt = prevAttempts + 1;
    const t = this.now();
    const record: HandoffRecord = {
      txn_id: args.txn_id,
      attempt,
      token: generateHandoffToken(),
      status: 'pending',
      reason: args.reason,
      summary: args.summary,
      details: args.details,
      created_at: t,
      expires_at: t + this.timeoutMs,
      last_known_url: args.last_known_url,
    };
    this.active.set(args.txn_id, record);
    this.attempts.set(args.txn_id, attempt);
    this.flush();
    return record;
  }

  /** Look up the active record for a txn (no mutation). */
  get(txnId: string): HandoffRecord | undefined {
    const r = this.active.get(txnId);
    if (!r) return undefined;
    if (r.status === 'pending' && this.now() >= r.expires_at) {
      r.status = 'expired';
      r.terminated_at = this.now();
    }
    return r;
  }

  /**
   * Validate a posted token and mark the handoff resumed. Single-use:
   * subsequent calls with the same token return wrong_status. Returns a
   * structured ResumeResult — callers should map it to HTTP 200/403/404.
   */
  resume(txnId: string, token: string): ResumeResult {
    const rec = this.active.get(txnId);
    if (!rec) return { ok: false, reason: 'unknown_txn' };
    if (rec.status === 'pending' && this.now() >= rec.expires_at) {
      rec.status = 'expired';
      rec.terminated_at = this.now();
    }
    if (rec.status !== 'pending') {
      return { ok: false, reason: rec.status === 'expired' ? 'expired' : 'wrong_status', record: rec };
    }
    // Lazy import to avoid circular module load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { verifyHandoffToken } = require('./token') as typeof import('./token');
    if (!verifyHandoffToken(token, rec.token)) {
      return { ok: false, reason: 'wrong_token', record: rec };
    }
    rec.status = 'resumed';
    rec.resumed_at = this.now();
    rec.terminated_at = this.now();
    this.flush();
    return { ok: true, record: rec };
  }

  /** Operator-initiated abort (skill gives up before timeout). */
  abort(txnId: string): HandoffRecord | undefined {
    const rec = this.active.get(txnId);
    if (!rec) return undefined;
    if (rec.status === 'pending') {
      rec.status = 'aborted';
      rec.terminated_at = this.now();
      this.flush();
    }
    return rec;
  }

  /**
   * Sweep expired handoffs and remove resumed/expired/aborted records
   * older than 24h. Returns the count purged. Hosts call this from a
   * timer or before each `create`.
   */
  sweep(): number {
    let purged = 0;
    const t = this.now();
    for (const [txn, rec] of this.active.entries()) {
      if (rec.status === 'pending' && t >= rec.expires_at) {
        rec.status = 'expired';
        rec.terminated_at = t;
      }
      // 24h GC anchored on the actual termination time, not on the
      // configured timeout: a handoff aborted 30 seconds in shouldn't
      // sit in memory for hours just because the configured TTL was
      // long. Records older than this codebase (no terminated_at set)
      // fall back to expires_at to stay backward-compatible.
      if (rec.status !== 'pending') {
        const ref = rec.terminated_at ?? rec.expires_at;
        if (t - ref > 24 * 60 * 60 * 1000) {
          this.active.delete(txn);
          this.attempts.delete(txn);
          purged += 1;
        }
      }
    }
    if (purged > 0) this.flush();
    return purged;
  }

  /** All currently-tracked records. Useful for status / inspection. */
  list(): HandoffRecord[] {
    return [...this.active.values()];
  }

  /** Test hook: drop everything (in-memory + persisted). */
  reset(): void {
    this.active.clear();
    this.attempts.clear();
    if (this.persistence) {
      try {
        this.persistence.clear();
      } catch {
        // ignore
      }
    }
  }
}
