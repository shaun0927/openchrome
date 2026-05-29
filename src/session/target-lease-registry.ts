export type TargetCleanupPolicy = 'close-on-session-end' | 'preserve' | 'expire';

export interface TargetLeaseRecord {
  targetId: string;
  sessionId: string;
  clientId?: string;
  workerId?: string;
  laneId?: string;
  contextName?: string;
  createdAt: number;
  lastActivityAt: number;
  leaseExpiresAt?: number;
  cleanupPolicy: TargetCleanupPolicy;
}

export interface AcquireTargetLeaseInput {
  targetId: string;
  sessionId: string;
  clientId?: string;
  workerId?: string;
  laneId?: string;
  contextName?: string;
  now?: number;
  ttlMs?: number;
  cleanupPolicy?: TargetCleanupPolicy;
}

export class TargetLeaseConflictError extends Error {
  readonly existing: TargetLeaseRecord;

  constructor(existing: TargetLeaseRecord) {
    super(`Target ${existing.targetId} is already leased by session ${existing.sessionId}`);
    this.name = 'TargetLeaseConflictError';
    this.existing = existing;
  }
}

export class TargetLeaseRegistry {
  private readonly leases = new Map<string, TargetLeaseRecord>();

  acquire(input: AcquireTargetLeaseInput): TargetLeaseRecord {
    const now = input.now ?? Date.now();
    const existing = this.leases.get(input.targetId);
    if (existing && existing.sessionId !== input.sessionId) throw new TargetLeaseConflictError(existing);
    const record: TargetLeaseRecord = {
      targetId: input.targetId,
      sessionId: input.sessionId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      ...(input.laneId ? { laneId: input.laneId } : {}),
      ...(input.contextName ? { contextName: input.contextName } : {}),
      createdAt: existing?.createdAt ?? now,
      lastActivityAt: now,
      ...(input.ttlMs ? { leaseExpiresAt: now + input.ttlMs } : existing?.leaseExpiresAt ? { leaseExpiresAt: existing.leaseExpiresAt } : {}),
      cleanupPolicy: input.cleanupPolicy ?? existing?.cleanupPolicy ?? 'close-on-session-end',
    };
    this.leases.set(input.targetId, record);
    return record;
  }

  inherit(targetId: string, parentTargetId: string, overrides: Partial<AcquireTargetLeaseInput> = {}): TargetLeaseRecord | null {
    const parent = this.leases.get(parentTargetId);
    if (!parent) return null;
    return this.acquire({
      targetId,
      sessionId: overrides.sessionId ?? parent.sessionId,
      clientId: overrides.clientId ?? parent.clientId,
      workerId: overrides.workerId ?? parent.workerId,
      laneId: overrides.laneId ?? parent.laneId,
      contextName: overrides.contextName ?? parent.contextName,
      now: overrides.now,
      cleanupPolicy: overrides.cleanupPolicy ?? parent.cleanupPolicy,
      ...(overrides.ttlMs ? { ttlMs: overrides.ttlMs } : {}),
    });
  }

  touch(targetId: string, now = Date.now()): void {
    const lease = this.leases.get(targetId);
    if (lease) lease.lastActivityAt = now;
  }

  get(targetId: string): TargetLeaseRecord | undefined {
    return this.leases.get(targetId);
  }

  release(targetId: string, sessionId?: string): boolean {
    const lease = this.leases.get(targetId);
    if (!lease) return false;
    if (sessionId && lease.sessionId !== sessionId) return false;
    return this.leases.delete(targetId);
  }

  releaseSession(sessionId: string): string[] {
    const released: string[] = [];
    for (const [targetId, lease] of this.leases) {
      if (lease.sessionId === sessionId) {
        this.leases.delete(targetId);
        released.push(targetId);
      }
    }
    return released;
  }

  expire(now = Date.now()): TargetLeaseRecord[] {
    const expired: TargetLeaseRecord[] = [];
    for (const [targetId, lease] of this.leases) {
      if (lease.leaseExpiresAt !== undefined && lease.leaseExpiresAt <= now) {
        this.leases.delete(targetId);
        expired.push(lease);
      }
    }
    return expired;
  }

  reconcileAliveTargetIds(aliveTargetIds: Set<string>): TargetLeaseRecord[] {
    const removed: TargetLeaseRecord[] = [];
    for (const [targetId, lease] of this.leases) {
      if (!aliveTargetIds.has(targetId)) {
        this.leases.delete(targetId);
        removed.push(lease);
      }
    }
    return removed;
  }

  snapshot(): TargetLeaseRecord[] {
    return Array.from(this.leases.values()).map((lease) => ({ ...lease }));
  }
}
