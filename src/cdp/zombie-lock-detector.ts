/**
 * Zombie lock detector for CDP controller leases (#1474).
 *
 * Owners can hold a controller lock after crashing/disconnecting, so new
 * sessions hang on `TargetLeaseConflictError` until the idle TTL expires.
 * This module runs a periodic heartbeat probe against the raw CDP target
 * list; if a leased target is missing for `confirmations` consecutive
 * probes it emits `owner_reclaim` so the broker can release the lock.
 * The detector never performs the reclaim itself — see zombie-lock-wiring.
 */

import { EventEmitter } from 'node:events';

/** Signature for a heartbeat probe. Must return the current set of CDP target ids. */
export type HeartbeatProbe = () => Promise<readonly string[]>;

export interface ZombieLockOptions {
  /** Heartbeat poll interval (ms). Default 5_000. */
  intervalMs?: number;
  /** Consecutive misses before reclaim. Default 2 (survives one flaky probe). */
  confirmations?: number;
  /** Grace window (ms) after register() during which misses are ignored. Default 1_500. */
  registrationGraceMs?: number;
  /** Injected clock, primarily for tests. */
  now?: () => number;
}

export interface ZombieLockEntry {
  targetId: string;
  ownerId: string;
  registeredAt: number;
  lastSeenAt: number;
  missingStreak: number;
  reclaimed: boolean;
}

export interface OwnerReclaimEvent {
  targetId: string;
  ownerId: string;
  reason: 'heartbeat-missing' | 'probe-error';
  lastSeenAt: number;
  detectedAt: number;
  missingStreak: number;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_CONFIRMATIONS = 2;
const DEFAULT_REGISTRATION_GRACE_MS = 1_500;

/** Emits `owner_reclaim` (zombie confirmed) and `probe-error` (probe threw). */
export class ZombieLockDetector extends EventEmitter {
  private readonly entries = new Map<string, ZombieLockEntry>();
  private readonly probe: HeartbeatProbe;
  private readonly intervalMs: number;
  private readonly confirmations: number;
  private readonly registrationGraceMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(probe: HeartbeatProbe, options: ZombieLockOptions = {}) {
    super();
    this.probe = probe;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.confirmations = Math.max(1, options.confirmations ?? DEFAULT_CONFIRMATIONS);
    this.registrationGraceMs = options.registrationGraceMs ?? DEFAULT_REGISTRATION_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Start the poll loop. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Do not block process exit purely on our heartbeat timer.
    this.timer.unref?.();
  }

  /** Stop and drop all state. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.entries.clear();
  }

  /** Register a new lease for observation. */
  register(targetId: string, ownerId: string): void {
    const now = this.now();
    this.entries.set(targetId, {
      targetId,
      ownerId,
      registeredAt: now,
      lastSeenAt: now,
      missingStreak: 0,
      reclaimed: false,
    });
  }

  /** Drop a lease from observation (e.g. after an orderly release). */
  unregister(targetId: string): void {
    this.entries.delete(targetId);
  }

  /** Read-only snapshot for diagnostics. */
  snapshot(): readonly ZombieLockEntry[] {
    return [...this.entries.values()];
  }

  /** One poll iteration. Exposed for tests. */
  async tick(): Promise<void> {
    let visible: readonly string[];
    try {
      visible = await this.probe();
    } catch (error) {
      this.emit('probe-error', error);
      return;
    }
    const visibleSet = new Set(visible);
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.reclaimed) continue;
      if (visibleSet.has(entry.targetId)) {
        entry.lastSeenAt = now;
        entry.missingStreak = 0;
        continue;
      }
      // Do not judge a lease that is still inside its registration grace.
      if (now - entry.registeredAt < this.registrationGraceMs) continue;
      entry.missingStreak += 1;
      if (entry.missingStreak >= this.confirmations) {
        entry.reclaimed = true;
        const event: OwnerReclaimEvent = {
          targetId: entry.targetId,
          ownerId: entry.ownerId,
          reason: 'heartbeat-missing',
          lastSeenAt: entry.lastSeenAt,
          detectedAt: now,
          missingStreak: entry.missingStreak,
        };
        this.emit('owner_reclaim', event);
      }
    }
  }
}
