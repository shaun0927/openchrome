/**
 * Zombie lock detector for CDP controller leases.
 *
 * Addresses upstream issue #1474: an owner may hold a controller lock long
 * after it has crashed, disconnected, or otherwise stopped servicing its
 * targets. Without an active liveness probe those locks look "healthy" to the
 * broker but cannot be reclaimed until the idle TTL expires. On long-running
 * agents that TTL is measured in minutes, which manifests as new sessions
 * hanging on `TargetLeaseConflictError` for no observable reason.
 *
 * This module is clean-room. It borrows the *idea* — periodic liveness probes
 * plus an explicit reclaim event — from the general CDP self-heal literature
 * (see the census entries for real-browser-mcp A17 and trycua A18), but does
 * not copy code. It is intentionally decoupled from `TargetLeaseRegistry` so
 * it can be wired in as a sidecar and unit-tested in isolation.
 *
 * Contract:
 *   1. Callers register each active lease via {@link register}.
 *   2. Callers set a heartbeat probe that resolves to the raw
 *      `Target.getTargets` frame identifiers currently visible on the
 *      controller. The detector diffs those against the leased targetIds.
 *   3. If a lease's target vanishes from the heartbeat *and* stays gone across
 *      {@link ZombieLockOptions.confirmations} probes, the detector emits an
 *      `owner_reclaim` event so the broker can drop the lock without waiting
 *      for the TTL.
 *
 * The detector never *performs* the reclaim — that is the broker's job. It
 * only decides "this owner is a zombie" and surfaces the decision.
 */

import { EventEmitter } from 'node:events';

/** Signature for a heartbeat probe. Must return the current set of CDP target ids. */
export type HeartbeatProbe = () => Promise<readonly string[]>;

export interface ZombieLockOptions {
  /**
   * How often to poll the heartbeat probe.
   * Defaults to 5s — enough to catch a crashed owner in one benchmark tick
   * without generating meaningful CDP overhead.
   */
  intervalMs?: number;
  /**
   * Number of consecutive "missing" observations required before the lease is
   * flagged as a zombie. Defaults to 2 to survive a single flaky probe.
   */
  confirmations?: number;
  /**
   * Grace period (ms) after {@link ZombieLockDetector.register}. During this
   * window the lease is ignored even if the target is not visible yet —
   * Chrome sometimes reports a new target on the following tick. Defaults to
   * 1_500ms.
   */
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

/**
 * Zombie lock detector.
 *
 * Emits:
 *   - `owner_reclaim` — an owner has been declared a zombie. Payload is
 *     {@link OwnerReclaimEvent}.
 *   - `probe-error` — the heartbeat probe threw. Payload is the raw Error.
 *     Consumers should log; a probe error alone does not reclaim.
 */
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
