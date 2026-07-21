import { FleetLease, LeaseHandle } from '../../src/session/fleet-lease';

describe('FleetLease (P18)', () => {
  let pool: FleetLease;
  beforeEach(() => {
    pool = new FleetLease();
  });

  describe('register / unregister', () => {
    test('register adds a worker to the pool', () => {
      pool.register('w1');
      expect(pool.ids()).toEqual(['w1']);
    });
    test('duplicate register merges meta, keeps state', () => {
      pool.register('w1', { label: 'a' });
      const h = pool.acquire({ sessionId: 's1', ttlMs: 1000 })!;
      pool.register('w1', { label: 'b' });
      const snap = pool.snapshot().find((s) => s.workerId === 'w1')!;
      expect(snap.meta.label).toBe('b');
      expect(snap.state).toBe('leased');
      pool.release(h);
    });
    test('unregister removes the worker', () => {
      pool.register('w1');
      pool.unregister('w1');
      expect(pool.ids()).toEqual([]);
    });
    test('rejects empty workerId', () => {
      expect(() => pool.register('')).toThrow(TypeError);
    });
  });

  describe('acquire', () => {
    test('returns null for empty pool', () => {
      expect(pool.acquire({ sessionId: 's', ttlMs: 100 })).toBeNull();
    });
    test('picks first available and marks it leased', () => {
      pool.register('w1');
      pool.register('w2');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100, }, 1000)!;
      expect(h.workerId).toBe('w1');
      expect(h.expiresAt).toBe(1100);
      expect(h.sessionId).toBe('s');
      expect(pool.snapshot().find((s) => s.workerId === 'w1')?.state).toBe('leased');
    });
    test('skips leased workers', () => {
      pool.register('w1');
      pool.register('w2');
      pool.acquire({ sessionId: 's1', ttlMs: 1000 });
      const h2 = pool.acquire({ sessionId: 's2', ttlMs: 1000 })!;
      expect(h2.workerId).toBe('w2');
    });
    test('respects avoid list', () => {
      pool.register('w1');
      pool.register('w2');
      const h = pool.acquire({ sessionId: 's', ttlMs: 1000, avoid: ['w1'] })!;
      expect(h.workerId).toBe('w2');
    });
    test('foreground driver never gets a background worker', () => {
      pool.register('bg', { background: true });
      expect(pool.acquire({ sessionId: 's', ttlMs: 100 })).toBeNull();
    });
    test('background driver never gets a foreground worker', () => {
      pool.register('fg');
      expect(pool.acquire({ sessionId: 's', ttlMs: 100, preferBackground: true })).toBeNull();
    });
    test('mixed pool routes to correct lane', () => {
      pool.register('fg1');
      pool.register('bg1', { background: true });
      const fg = pool.acquire({ sessionId: 's1', ttlMs: 100 })!;
      const bg = pool.acquire({ sessionId: 's2', ttlMs: 100, preferBackground: true })!;
      expect(fg.workerId).toBe('fg1');
      expect(bg.workerId).toBe('bg1');
    });
    test('rejects missing sessionId', () => {
      pool.register('w1');
      expect(() => pool.acquire({ sessionId: '', ttlMs: 100 } as any)).toThrow(TypeError);
    });
    test('rejects non-positive ttlMs', () => {
      pool.register('w1');
      expect(() => pool.acquire({ sessionId: 's', ttlMs: 0 })).toThrow(RangeError);
      expect(() => pool.acquire({ sessionId: 's', ttlMs: -1 })).toThrow(RangeError);
    });
    test('auto-reclaims expired lease before returning', () => {
      pool.register('w1');
      const h1 = pool.acquire({ sessionId: 's1', ttlMs: 100 }, 1000)!;
      expect(h1.workerId).toBe('w1');
      // At now=2000 the lease has expired.
      const h2 = pool.acquire({ sessionId: 's2', ttlMs: 100 }, 2000)!;
      expect(h2.workerId).toBe('w1');
      expect(h2.sessionId).toBe('s2');
      expect(h2.token).not.toBe(h1.token);
    });
  });

  describe('renew', () => {
    test('slides expiresAt forward', () => {
      pool.register('w1');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100 }, 1000)!;
      const r = pool.renew(h, 500, 1050)!;
      expect(r.expiresAt).toBe(1550);
      expect(r.token).toBe(h.token);
    });
    test('rejects handle whose lease was reclaimed', () => {
      pool.register('w1');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100 }, 1000)!;
      pool.acquire({ sessionId: 's2', ttlMs: 100 }, 2000); // reclaims + re-leases
      expect(pool.renew(h, 500, 2100)).toBeNull();
    });
    test('rejects handle for unregistered worker', () => {
      const h: LeaseHandle = {
        workerId: 'ghost', sessionId: 's', expiresAt: 1, issuedAt: 0, token: 'x',
      };
      expect(pool.renew(h, 500)).toBeNull();
    });
    test('rejects non-positive ttlMs', () => {
      pool.register('w1');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100 })!;
      expect(() => pool.renew(h, 0)).toThrow(RangeError);
    });
  });

  describe('release', () => {
    test('returns worker to available', () => {
      pool.register('w1');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100 })!;
      expect(pool.release(h)).toBe(true);
      expect(pool.snapshot()[0].state).toBe('available');
    });
    test('rejects handle with wrong token', () => {
      pool.register('w1');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100 })!;
      const fake: LeaseHandle = { ...h, token: 'wrong' };
      expect(pool.release(fake)).toBe(false);
    });
    test('release of already-released is no-op', () => {
      pool.register('w1');
      const h = pool.acquire({ sessionId: 's', ttlMs: 100 })!;
      pool.release(h);
      expect(pool.release(h)).toBe(false);
    });
  });

  describe('sweep', () => {
    test('reclaims expired leases and returns count', () => {
      pool.register('w1');
      pool.register('w2');
      pool.acquire({ sessionId: 's1', ttlMs: 100 }, 1000);
      pool.acquire({ sessionId: 's2', ttlMs: 100 }, 1000);
      expect(pool.sweep(2000)).toBe(2);
      expect(pool.snapshot().every((s) => s.state === 'available')).toBe(true);
    });
    test('does not touch un-expired leases', () => {
      pool.register('w1');
      pool.acquire({ sessionId: 's', ttlMs: 10_000 }, 1000);
      expect(pool.sweep(1100)).toBe(0);
      expect(pool.snapshot()[0].state).toBe('leased');
    });
  });

  describe('snapshot', () => {
    test('reports state and expiry for observability', () => {
      pool.register('w1', { label: 'main' });
      pool.register('w2', { background: true });
      pool.acquire({ sessionId: 's', ttlMs: 100 }, 1000);
      const snap = pool.snapshot();
      expect(snap).toEqual([
        { workerId: 'w1', state: 'leased', meta: { label: 'main' }, expiresAt: 1100 },
        { workerId: 'w2', state: 'available', meta: { background: true }, expiresAt: null },
      ]);
    });
  });
});
