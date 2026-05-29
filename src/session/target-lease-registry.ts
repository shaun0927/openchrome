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
  /**
   * Idle TTL in ms, stored so {@link TargetLeaseRegistry.touch} can slide
   * `leaseExpiresAt` forward on activity. A lease only reaches `expire()` after
   * its owner has been silent for `ttlMs` — i.e. a disconnected/crashed client.
   */
  ttlMs?: number;
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
    // Carry the idle TTL across re-acquires so a refreshed lease keeps sliding.
    const ttlMs = input.ttlMs ?? existing?.ttlMs;
    const record: TargetLeaseRecord = {
      targetId: input.targetId,
      sessionId: input.sessionId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      ...(input.laneId ? { laneId: input.laneId } : {}),
      ...(input.contextName ? { contextName: input.contextName } : {}),
      createdAt: existing?.createdAt ?? now,
      lastActivityAt: now,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(ttlMs !== undefined ? { leaseExpiresAt: now + ttlMs } : existing?.leaseExpiresAt ? { leaseExpiresAt: existing.leaseExpiresAt } : {}),
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
      // Carry the idle TTL like every other field: prefer an explicit override,
      // else inherit the parent's so a popup/child target slides and expires on
      // the same schedule as its opener. Use `!== undefined` (not truthiness) so
      // a deliberate ttlMs:0 override is honoured rather than silently dropped.
      ...(overrides.ttlMs !== undefined
        ? { ttlMs: overrides.ttlMs }
        : parent.ttlMs !== undefined
          ? { ttlMs: parent.ttlMs }
          : {}),
    });
  }

  touch(targetId: string, now = Date.now()): void {
    const lease = this.leases.get(targetId);
    if (!lease) return;
    lease.lastActivityAt = now;
    // Sliding idle TTL: any activity pushes expiry forward, so an actively used
    // tab is never reclaimed; only an idle/crashed owner's lease reaches expiry.
    if (lease.ttlMs !== undefined) lease.leaseExpiresAt = now + lease.ttlMs;
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
