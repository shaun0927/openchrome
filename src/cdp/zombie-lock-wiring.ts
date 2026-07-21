/**
 * Runtime wiring for ZombieLockDetector (#1474).
 * Turns `owner_reclaim` events into real `TargetLeaseRegistry.releaseSession`
 * calls, adapts CDPClient.getTargets() into the heartbeat probe, and keeps
 * an audit ledger. Opt-in via OPENCHROME_ZOMBIE_LOCK_DETECTOR=1.
 * SessionManager.acquireTargetLease is the broker call site.
 */

import {
  ZombieLockDetector,
  type OwnerReclaimEvent,
  type ZombieLockOptions,
} from './zombie-lock-detector.js';
import type { TargetLeaseRegistry } from '../session/target-lease-registry.js';

/** Minimal CDPClient surface the wiring needs. */
export interface ZombieLockWiringCdp {
  getTargets(): Array<{ _targetId?: string } | unknown>;
}

/** One audit entry per `owner_reclaim` event. Read by ops via the wiring handle. */
export interface ZombieReclaimAuditEntry {
  targetId: string;
  ownerId: string;
  sessionId?: string;
  reason: OwnerReclaimEvent['reason'];
  detectedAt: number;
  missingStreak: number;
  releasedTargets: readonly string[];
}

/** Extract targetId from a puppeteer Target-like object without importing puppeteer here. */
function extractTargetId(t: unknown): string | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const anyT = t as { _targetInfo?: { targetId?: string }; id?: string };
  return anyT._targetInfo?.targetId ?? anyT.id;
}

export interface ZombieLockWiringHandle {
  detector: ZombieLockDetector;
  audit: readonly ZombieReclaimAuditEntry[];
  /** Call when a lease is acquired so it becomes visible to the detector. */
  registerLease(targetId: string, ownerId: string): void;
  /** Call when a lease is released. */
  unregisterLease(targetId: string): void;
  /** Tear everything down. Idempotent. */
  dispose(): void;
}

export interface ZombieLockWiringOptions extends ZombieLockOptions {
  /** Override the detector construction — used by tests. */
  detector?: ZombieLockDetector;
}

/** Feature-flag check. Exposed for tests. */
export function isZombieLockDetectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENCHROME_ZOMBIE_LOCK_DETECTOR;
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on';
}

/** Bind an `owner_reclaim` handler that releases the session + appends audit. Returns unsub. */
export function attachZombieReclaim(
  detector: ZombieLockDetector,
  registry: TargetLeaseRegistry,
  audit: ZombieReclaimAuditEntry[] = [],
): () => void {
  const handler = (event: OwnerReclaimEvent) => {
    const lease = registry.get(event.targetId);
    if (!lease) {
      audit.push({
        targetId: event.targetId,
        ownerId: event.ownerId,
        reason: event.reason,
        detectedAt: event.detectedAt,
        missingStreak: event.missingStreak,
        releasedTargets: [],
      });
      return;
    }
    const released = registry.releaseSession(lease.sessionId);
    audit.push({
      targetId: event.targetId,
      ownerId: event.ownerId,
      sessionId: lease.sessionId,
      reason: event.reason,
      detectedAt: event.detectedAt,
      missingStreak: event.missingStreak,
      releasedTargets: released,
    });
  };
  detector.on('owner_reclaim', handler);
  return () => detector.off('owner_reclaim', handler);
}

/**
 * Wire a detector to a CDPClient + TargetLeaseRegistry.
 * SessionManager.acquireTargetLease calls the returned handle's registerLease
 * on every acquisition; the reclaim handler calls registry.releaseSession
 * when the detector fires. This is the real broker path.
 */
export function wireZombieLockDetector(
  cdp: ZombieLockWiringCdp,
  registry: TargetLeaseRegistry,
  options: ZombieLockWiringOptions = {},
): ZombieLockWiringHandle {
  const { detector: injected, ...detectorOptions } = options;
  const probe = async (): Promise<readonly string[]> => {
    const targets = cdp.getTargets();
    const ids: string[] = [];
    for (const t of targets) {
      const id = extractTargetId(t);
      if (id) ids.push(id);
    }
    return ids;
  };
  const detector = injected ?? new ZombieLockDetector(probe, detectorOptions);
  const audit: ZombieReclaimAuditEntry[] = [];
  const detach = attachZombieReclaim(detector, registry, audit);
  detector.start();
  let disposed = false;
  return {
    detector,
    audit,
    registerLease(targetId, ownerId) {
      if (disposed) return;
      detector.register(targetId, ownerId);
    },
    unregisterLease(targetId) {
      if (disposed) return;
      detector.unregister(targetId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      detector.stop();
    },
  };
}
