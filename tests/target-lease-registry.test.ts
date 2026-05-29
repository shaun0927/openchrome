import { TargetLeaseConflictError, TargetLeaseRegistry } from '../src/session/target-lease-registry';

describe('TargetLeaseRegistry', () => {
  test('acquires and snapshots leases with ownership metadata', () => {
    const registry = new TargetLeaseRegistry();
    const lease = registry.acquire({ targetId: 't1', sessionId: 's1', clientId: 'c1', workerId: 'w1', laneId: 'l1', contextName: 'ctx', now: 10, ttlMs: 1000 });

    expect(lease).toMatchObject({ targetId: 't1', sessionId: 's1', clientId: 'c1', workerId: 'w1', laneId: 'l1', contextName: 'ctx', createdAt: 10, lastActivityAt: 10, leaseExpiresAt: 1010 });
    expect(registry.snapshot()).toHaveLength(1);
  });

  test('rejects another session acquiring an active lease', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 't1', sessionId: 's1' });

    expect(() => registry.acquire({ targetId: 't1', sessionId: 's2' })).toThrow(TargetLeaseConflictError);
  });

  test('inherits popup ownership from parent target', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 'parent', sessionId: 's1', workerId: 'w1', contextName: 'ctx' });

    const popup = registry.inherit('popup', 'parent');

    expect(popup).toMatchObject({ targetId: 'popup', sessionId: 's1', workerId: 'w1', contextName: 'ctx' });
  });

  test('release with no sessionId drops a lease so recovery can transfer ownership', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 't1', sessionId: 's1' });

    expect(registry.release('t1')).toBe(true);
    // The recovery path (SessionManager.tryRecoverTarget) re-acquires under
    // the new owner once the stale lease has been released.
    expect(registry.acquire({ targetId: 't1', sessionId: 's2' })).toMatchObject({ sessionId: 's2' });
  });

  test('expires and reconciles orphan leases', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 'expired', sessionId: 's1', now: 0, ttlMs: 10 });
    registry.acquire({ targetId: 'alive', sessionId: 's1' });
    registry.acquire({ targetId: 'gone', sessionId: 's2' });

    expect(registry.expire(11).map((lease) => lease.targetId)).toEqual(['expired']);
    expect(registry.reconcileAliveTargetIds(new Set(['alive'])).map((lease) => lease.targetId)).toEqual(['gone']);
    expect(registry.snapshot().map((lease) => lease.targetId)).toEqual(['alive']);
  });

  test('touch slides the idle TTL forward so an active lease is never reclaimed', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 't1', sessionId: 's1', now: 0, ttlMs: 100 });
    // Without activity the lease would expire at 100.
    expect(registry.get('t1')?.leaseExpiresAt).toBe(100);

    // Activity at t=80 slides expiry to 180.
    registry.touch('t1', 80);
    expect(registry.get('t1')?.leaseExpiresAt).toBe(180);

    // So at t=120 (past the original deadline) the lease is still alive — this is
    // the long-running-agent case the SSOT open question #4 worried about.
    expect(registry.expire(120)).toEqual([]);
    // Only after a full idle window with no further activity does it expire.
    expect(registry.expire(181).map((lease) => lease.targetId)).toEqual(['t1']);
  });

  test('a lease acquired without a TTL never expires (touch does not arm one)', () => {
    const registry = new TargetLeaseRegistry();
    // Mirrors the "default" session exemption wired in SessionManager.
    registry.acquire({ targetId: 'default', sessionId: 's1', now: 0 });
    registry.touch('default', 10_000);
    expect(registry.get('default')?.leaseExpiresAt).toBeUndefined();
    expect(registry.expire(1_000_000)).toEqual([]);
  });

  test('re-acquire by the same session carries and refreshes the idle TTL', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 't1', sessionId: 's1', now: 0, ttlMs: 100 });
    // Re-acquire (e.g. ownership transfer to the same session) at t=50 without a
    // ttlMs argument still carries the original TTL and refreshes the deadline.
    registry.acquire({ targetId: 't1', sessionId: 's1', now: 50 });
    expect(registry.get('t1')?.ttlMs).toBe(100);
    expect(registry.get('t1')?.leaseExpiresAt).toBe(150);
  });

  test('inherit carries the parent idle TTL so a popup expires on the same schedule', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 'parent', sessionId: 's1', now: 0, ttlMs: 100 });

    // No explicit ttlMs override: the popup should still inherit the parent's TTL
    // (like cleanupPolicy/contextName) rather than becoming a never-expiring lease.
    const popup = registry.inherit('popup', 'parent', { now: 0 });
    expect(popup?.ttlMs).toBe(100);
    expect(popup?.leaseExpiresAt).toBe(100);
    expect(registry.expire(101).map((lease) => lease.targetId).sort()).toEqual(['parent', 'popup']);
  });

  test('inherit honours an explicit ttlMs override instead of falling back to the parent', () => {
    const registry = new TargetLeaseRegistry();
    registry.acquire({ targetId: 'parent', sessionId: 's1', now: 0, ttlMs: 100 });

    // An explicit override wins over the parent's TTL. (Registry semantics: any
    // numeric ttlMs sets leaseExpiresAt = now + ttlMs; the "0 disables" rule lives
    // one layer up in SessionManager, which maps 0 → undefined before acquiring.)
    const popup = registry.inherit('popup', 'parent', { now: 0, ttlMs: 50 });
    expect(popup?.ttlMs).toBe(50);
    expect(popup?.leaseExpiresAt).toBe(50);
  });
});
