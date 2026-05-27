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
});
