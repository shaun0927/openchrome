import type { TargetLeaseRecord } from '../session/target-lease-registry';

export type SharedProfileTrustMode = 'same-trust-zone' | 'isolated-required';

export interface SharedProfilePolicy {
  trustMode: SharedProfileTrustMode;
  allowCrossTenantDiagnostics: boolean;
  redactUrls: boolean;
  redactTitles: boolean;
}

export interface RedactedLeaseDiagnostic {
  targetId: string;
  sessionId: string;
  clientId?: string;
  workerId?: string;
  laneId?: string;
  contextName?: string;
  createdAt: number;
  lastActivityAt: number;
  leaseExpiresAt?: number;
  cleanupPolicy: string;
  redacted: boolean;
}

export function getSharedProfilePolicy(env: NodeJS.ProcessEnv = process.env): SharedProfilePolicy {
  const allowCrossTenantDiagnostics = env.OPENCHROME_SHARED_PROFILE_CROSS_TENANT_DIAGNOSTICS === '1';
  const trustMode: SharedProfileTrustMode = env.OPENCHROME_SHARED_PROFILE_UNTRUSTED === '1' ? 'isolated-required' : 'same-trust-zone';
  return {
    trustMode,
    allowCrossTenantDiagnostics,
    redactUrls: true,
    redactTitles: true,
  };
}

export function assertSharedProfileAllowed(policy = getSharedProfilePolicy()): void {
  if (policy.trustMode === 'isolated-required') {
    throw new Error('Shared-profile broker mode is same-trust-zone only. Use separate --port and --user-data-dir for untrusted or unrelated clients.');
  }
}

export function canAccessLeaseDiagnostic(
  lease: TargetLeaseRecord,
  requester: { sessionId?: string; clientId?: string },
  policy = getSharedProfilePolicy(),
): boolean {
  if (policy.allowCrossTenantDiagnostics) return true;
  if (requester.sessionId && requester.sessionId === lease.sessionId) return true;
  if (requester.clientId && lease.clientId && requester.clientId === lease.clientId) return true;
  return false;
}

export function redactLeaseDiagnostic(
  lease: TargetLeaseRecord,
  requester: { sessionId?: string; clientId?: string },
  policy = getSharedProfilePolicy(),
): RedactedLeaseDiagnostic | null {
  if (!canAccessLeaseDiagnostic(lease, requester, policy)) return null;
  return {
    targetId: lease.targetId,
    sessionId: lease.sessionId,
    ...(lease.clientId ? { clientId: lease.clientId } : {}),
    ...(lease.workerId ? { workerId: lease.workerId } : {}),
    ...(lease.laneId ? { laneId: lease.laneId } : {}),
    ...(lease.contextName ? { contextName: lease.contextName } : {}),
    createdAt: lease.createdAt,
    lastActivityAt: lease.lastActivityAt,
    ...(lease.leaseExpiresAt ? { leaseExpiresAt: lease.leaseExpiresAt } : {}),
    cleanupPolicy: lease.cleanupPolicy,
    redacted: policy.redactUrls || policy.redactTitles,
  };
}
