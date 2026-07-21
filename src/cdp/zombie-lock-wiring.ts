/**
 * Runtime wiring for {@link ZombieLockDetector} + {@link attachZombieReclaim}.
 *
 * The detector and reclaim helper are intentionally decoupled from the
 * session-manager so they can be unit-tested in isolation. This module is the
 * thin adapter that turns the two side-effect-free primitives into a real
 * broker-side liveness probe: it wires the heartbeat probe to
 * `CDPClient.getTargets()`, registers every lease acquisition/release with the
 * detector, and asks {@link attachZombieReclaim} to release the affected
 * session on `owner_reclaim`.
 *
 * Opt-in only. Enabled via `OPENCHROME_ZOMBIE_LOCK_DETECTOR=1` so no runtime
 * behaviour changes by default. Failing to set the flag leaves the previous
 * idle-TTL path intact.
 *
 * The wiring is exposed as a factory so callers (session-manager, tests) can
 * construct and dispose an instance without touching module-level state.
 */

import { ZombieLockDetector, type ZombieLockOptions } from './zombie-lock-detector.js';
import { attachZombieReclaim, type ZombieReclaimAuditEntry } from './zombie-lock-integration.js';
import type { TargetLeaseRegistry } from '../session/target-lease-registry.js';

/** Minimal CDPClient surface the wiring needs. */
export interface ZombieLockWiringCdp {
  getTargets(): Array<{ _targetId?: string } | unknown>;
}

/** Extract targetId from a puppeteer Target-like object without importing puppeteer here. */
function extractTargetId(t: unknown): string | undefined {
  if (!t || typeof t !== 'object') return undefined;
  // puppeteer Target exposes _targetInfo.targetId. Fall back to `.id` for stubs.
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
  /**
   * Override the detector construction — used by tests. When set, the wiring
   * skips constructing a probe from `cdp` and uses the injected detector.
   */
  detector?: ZombieLockDetector;
}

/**
 * Feature-flag check. Exposed for tests.
 */
export function isZombieLockDetectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENCHROME_ZOMBIE_LOCK_DETECTOR;
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on';
}

/**
 * Wire a zombie-lock detector to a CDPClient and a TargetLeaseRegistry.
 *
 * Returns a handle exposing `registerLease` / `unregisterLease` so the
 * session-manager can keep the detector's view in sync with real leases.
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
