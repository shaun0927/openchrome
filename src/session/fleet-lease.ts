/**
 * Fleet lease — worker-scoped rotating browser pool with lease TTL.
 *
 * Why this exists
 * ---------------
 * openchrome's `TargetLeaseRegistry` (src/session/target-lease-registry.ts)
 * tracks lease ownership at the **target** level — one CDP target ↔ one
 * session. That's the right primitive for a single-user, single-Chrome
 * layout, but for two other patterns it leaves gaps:
 *
 *  1. A **fleet** of Chrome workers — an operator running several
 *     independent tabs or profiles in parallel, each with its own
 *     lifecycle. The registry needs to answer "which worker owns which
 *     lease right now, and which worker is next in line?"
 *  2. A **background non-focus** worker — a lease that lives on a tab
 *     the user is not looking at. openchrome must be able to acquire,
 *     drive, and release the lease **without** raising the tab to
 *     focus (which every desktop OS treats as an activation event and
 *     stealth vendors then fingerprint).
 *
 * trycua's Fleet Lease primitive answers both: an in-memory pool of
 * `workerId → { available|leased, until, activatedBy }` entries with
 * `acquire()` / `renew()` / `release()` returning a `LeaseHandle`
 * carrying the id and expiry.
 *
 * Design
 * ------
 * - `FleetLease` is a pure in-process orchestrator. It does not spawn
 *   or touch Chrome — that's the launcher's job. Callers wire it into
 *   whatever spawn/attach layer they use.
 * - Registration: `register(workerId, meta?)` adds an entry to the
 *   pool. Registering the same id twice replaces the meta but keeps
 *   the lease state.
 * - Acquire: `acquire({ sessionId, ttlMs, avoid?, preferBackground? })`
 *   picks the first eligible worker (available, not in avoid[], and
 *   optionally marked backgroundable). Returns a `LeaseHandle` or
 *   null when the pool is exhausted.
 * - Renew: `renew(handle, ttlMs)` slides expiry forward. Rejects
 *   handles whose lease has already been reclaimed by expiry.
 * - Release: `release(handle)` returns the worker to the pool.
 * - Sweep: `sweep(nowMs?)` reclaims expired leases. Callers arm a
 *   timer that calls this periodically; the pool is race-free
 *   because sweep-then-acquire is serialised in JS's single thread.
 *
 * Non-focus idiom
 * ---------------
 * `LeaseMeta.background = true` marks a worker whose CDP session may
 * only be driven with commands that do **not** raise the tab to
 * focus. Currently the flag is a hint the caller passes through to
 * its own driver layer — see `docs/orchestration/fleet-non-focus.md`
 * for the recommended CDP command list (Page.reload, Target.attachToTarget,
 * DOM/Runtime evaluation) and the ones to avoid (`Page.bringToFront`,
 * `Input.dispatchMouseEvent` at coordinates covered by another
 * window). The lease primitive enforces the flag by refusing to
 * hand out background workers to callers that did not opt in via
 * `preferBackground` — a foreground driver cannot accidentally take
 * a background lease.
 *
 * Origin credit
 * -------------
 * Idiom from trycua's Fleet Lease primitive (MIT). Clean-room
 * implementation; no upstream code copied.
 */

export type LeaseState = 'available' | 'leased';

export interface LeaseMeta {
  /**
   * When true, this worker is expected to be driven without raising
   * the tab to focus. Foreground callers get skipped over this
   * worker unless they explicitly set `preferBackground: false` (in
   * which case they still get skipped — the flag is worker-side).
   */
  background?: boolean;
  /** Free-form label; useful for logs and dashboards. */
  label?: string;
}

export interface LeaseHandle {
  readonly workerId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  /** Opaque token that identifies this lease instance. Renewals check it. */
  readonly token: string;
}

export interface AcquireOptions {
  sessionId: string;
  ttlMs: number;
  /** Skip these workers even if available. */
  avoid?: readonly string[];
  /**
   * When true, only pick workers whose `LeaseMeta.background === true`.
   * When false or undefined, only pick workers whose background flag is
   * false/undefined. This is the opt-in that keeps a foreground driver
   * from grabbing a background lease.
   */
  preferBackground?: boolean;
}

interface WorkerEntry {
  workerId: string;
  meta: LeaseMeta;
  state: LeaseState;
  handle: LeaseHandle | null;
}

let _tokenCounter = 0;
function mintToken(): string {
  _tokenCounter += 1;
  return `lh-${Date.now().toString(36)}-${_tokenCounter.toString(36)}`;
}

export class FleetLease {
  private readonly workers = new Map<string, WorkerEntry>();

  register(workerId: string, meta: LeaseMeta = {}): void {
    if (typeof workerId !== 'string' || workerId.length === 0) {
      throw new TypeError('FleetLease.register: workerId must be a non-empty string');
    }
    const existing = this.workers.get(workerId);
    if (existing) {
      existing.meta = { ...existing.meta, ...meta };
      return;
    }
    this.workers.set(workerId, {
      workerId,
      meta: { ...meta },
      state: 'available',
      handle: null,
    });
  }

  unregister(workerId: string): void {
    this.workers.delete(workerId);
  }

  /** All registered worker ids, in insertion order. */
  ids(): string[] {
    return [...this.workers.keys()];
  }

  /** Snapshot of pool state — for dashboards. */
  snapshot(): { workerId: string; state: LeaseState; meta: LeaseMeta; expiresAt: number | null }[] {
    return [...this.workers.values()].map((w) => ({
      workerId: w.workerId,
      state: w.state,
      meta: { ...w.meta },
      expiresAt: w.handle ? w.handle.expiresAt : null,
    }));
  }

  acquire(opts: AcquireOptions, nowMs: number = Date.now()): LeaseHandle | null {
    if (!opts || typeof opts.sessionId !== 'string' || opts.sessionId.length === 0) {
      throw new TypeError('FleetLease.acquire: opts.sessionId required');
    }
    if (typeof opts.ttlMs !== 'number' || opts.ttlMs <= 0) {
      throw new RangeError('FleetLease.acquire: opts.ttlMs must be > 0');
    }
    // Reclaim expired leases first so the acquire is race-free with sweep.
    this.reclaimExpired(nowMs);
    const avoid = new Set(opts.avoid ?? []);
    const wantBackground = opts.preferBackground === true;
    for (const entry of this.workers.values()) {
      if (entry.state !== 'available') continue;
      if (avoid.has(entry.workerId)) continue;
      const isBackground = entry.meta.background === true;
      if (wantBackground !== isBackground) continue;
      const handle: LeaseHandle = {
        workerId: entry.workerId,
        sessionId: opts.sessionId,
        issuedAt: nowMs,
        expiresAt: nowMs + opts.ttlMs,
        token: mintToken(),
      };
      entry.state = 'leased';
      entry.handle = handle;
      return handle;
    }
    return null;
  }

  renew(handle: LeaseHandle, ttlMs: number, nowMs: number = Date.now()): LeaseHandle | null {
    if (typeof ttlMs !== 'number' || ttlMs <= 0) {
      throw new RangeError('FleetLease.renew: ttlMs must be > 0');
    }
    const entry = this.workers.get(handle.workerId);
    if (!entry || entry.state !== 'leased' || !entry.handle) return null;
    if (entry.handle.token !== handle.token) return null;
    const renewed: LeaseHandle = {
      ...entry.handle,
      expiresAt: nowMs + ttlMs,
    };
    entry.handle = renewed;
    return renewed;
  }

  release(handle: LeaseHandle): boolean {
    const entry = this.workers.get(handle.workerId);
    if (!entry || !entry.handle) return false;
    if (entry.handle.token !== handle.token) return false;
    entry.state = 'available';
    entry.handle = null;
    return true;
  }

  /**
   * Reclaim any lease whose expiry has passed. Returns the number
   * reclaimed. Callers arm a timer to run this periodically.
   */
  sweep(nowMs: number = Date.now()): number {
    return this.reclaimExpired(nowMs);
  }

  private reclaimExpired(nowMs: number): number {
    let n = 0;
    for (const entry of this.workers.values()) {
      if (entry.state === 'leased' && entry.handle && entry.handle.expiresAt <= nowMs) {
        entry.state = 'available';
        entry.handle = null;
        n += 1;
      }
    }
    return n;
  }
}
