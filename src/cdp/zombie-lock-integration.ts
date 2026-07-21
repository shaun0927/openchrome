/**
 * Broker-facing integration for {@link ZombieLockDetector}.
 *
 * The detector itself is passive: it decides "this owner is a zombie" and
 * emits an event. This integration layer is the small amount of wiring that
 * turns that event into a real reclaim on `TargetLeaseRegistry`, while
 * preserving the ledger of released targetIds so operators can audit which
 * leases were force-broken and why.
 *
 * Kept as its own module so the pure detector can stay side-effect free (it
 * does not depend on the lease registry) and so the wiring can be unit-tested
 * without spinning up a real CDP client.
 */

import type {
  OwnerReclaimEvent,
  ZombieLockDetector,
} from './zombie-lock-detector.js';
import type { TargetLeaseRegistry } from '../session/target-lease-registry.js';

export interface ZombieReclaimAuditEntry {
  targetId: string;
  ownerId: string;
  sessionId?: string;
  reason: OwnerReclaimEvent['reason'];
  detectedAt: number;
  missingStreak: number;
  releasedTargets: readonly string[];
}

/**
 * Wire a detector to a lease registry so `owner_reclaim` events actually
 * free the affected session. Returns an unsubscribe function.
 */
export function attachZombieReclaim(
  detector: ZombieLockDetector,
  registry: TargetLeaseRegistry,
  audit: ZombieReclaimAuditEntry[] = [],
): () => void {
  const handler = (event: OwnerReclaimEvent) => {
    const lease = registry.get(event.targetId);
    if (!lease) {
      // Someone else already released it. Record for observability.
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
