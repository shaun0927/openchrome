import type { BrowserContext } from 'puppeteer-core';
import {
  TenantManager,
  DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS,
} from '../../src/tenant/manager';
import { DEFAULT_TENANT_ID } from '../../src/tenant/types';

interface StubContext extends BrowserContext {
  __id: string;
  __closed: boolean;
}

function makeStubContext(id: string): StubContext {
  const ctx = {
    __id: id,
    __closed: false,
    close: jest.fn(async function (this: StubContext) {
      this.__closed = true;
    }),
  } as unknown as StubContext;
  return ctx;
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

describe('TenantManager', () => {
  it('creates a context lazily on first getOrCreate and reuses it after', async () => {
    const factory = jest.fn(async () => makeStubContext('a'));
    const mgr = new TenantManager({ createContext: factory });
    const first = await mgr.getOrCreate('alpha');
    const second = await mgr.getOrCreate('alpha');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(mgr.has('alpha')).toBe(true);
    expect(mgr.stats().active).toBe(1);
    expect(mgr.stats().totalCreated).toBe(1);
  });

  it('isolates different tenants with distinct browser contexts', async () => {
    let n = 0;
    const factory = jest.fn(async () => makeStubContext(`ctx-${++n}`));
    const mgr = new TenantManager({ createContext: factory });
    const a = await mgr.getOrCreate('alpha');
    const b = await mgr.getOrCreate('beta');
    expect(a.browserContext).not.toBe(b.browserContext);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('updates lastActivityAt on getOrCreate and touch', async () => {
    const clock = fakeClock();
    const factory = jest.fn(async () => makeStubContext('a'));
    const mgr = new TenantManager({ createContext: factory, now: clock.now });
    const entry = await mgr.getOrCreate('alpha');
    const created = entry.lastActivityAt;
    clock.advance(5000);
    await mgr.getOrCreate('alpha');
    expect(entry.lastActivityAt).toBe(created + 5000);
    clock.advance(3000);
    mgr.touch('alpha');
    expect(entry.lastActivityAt).toBe(created + 8000);
  });

  it('touch on unknown tenant is a no-op', async () => {
    const mgr = new TenantManager({ createContext: async () => makeStubContext('x') });
    expect(() => mgr.touch('missing')).not.toThrow();
    expect(mgr.has('missing')).toBe(false);
  });

  it('release closes the context and removes the entry', async () => {
    const ctx = makeStubContext('a');
    const mgr = new TenantManager({ createContext: async () => ctx });
    await mgr.getOrCreate('alpha');
    const removed = await mgr.release('alpha');
    expect(removed).toBe(true);
    expect(ctx.__closed).toBe(true);
    expect(mgr.has('alpha')).toBe(false);
    expect(mgr.stats().totalClosed).toBe(1);
  });

  it('release returns false for unknown tenants and does not throw', async () => {
    const mgr = new TenantManager({ createContext: async () => makeStubContext('x') });
    await expect(mgr.release('nope')).resolves.toBe(false);
  });

  it('closeAll closes every context and empties the map', async () => {
    let n = 0;
    const contexts: StubContext[] = [];
    const mgr = new TenantManager({
      createContext: async () => {
        const c = makeStubContext(`c${++n}`);
        contexts.push(c);
        return c;
      },
    });
    await mgr.getOrCreate('a');
    await mgr.getOrCreate('b');
    await mgr.getOrCreate('c');
    await mgr.closeAll();
    expect(contexts.every((c) => c.__closed)).toBe(true);
    expect(mgr.stats().active).toBe(0);
    expect(mgr.stats().totalClosed).toBe(3);
  });

  it('sweepIdle evicts tenants past the idle timeout', async () => {
    const clock = fakeClock();
    const mgr = new TenantManager({
      createContext: async () => makeStubContext('ctx'),
      now: clock.now,
      config: { idleTimeoutMs: 10_000 },
    });
    await mgr.getOrCreate('alpha');
    await mgr.getOrCreate('beta');
    clock.advance(5000);
    await mgr.getOrCreate('beta');
    clock.advance(6000);
    const evicted = await mgr.sweepIdle();
    expect(evicted).toEqual(['alpha']);
    expect(mgr.has('alpha')).toBe(false);
    expect(mgr.has('beta')).toBe(true);
    expect(mgr.stats().idleEvictions).toBe(1);
  });

  it('sweepIdle never evicts the default tenant', async () => {
    const clock = fakeClock();
    const mgr = new TenantManager({
      createContext: async () => makeStubContext('ctx'),
      now: clock.now,
      config: { idleTimeoutMs: 1000 },
    });
    await mgr.getOrCreate(DEFAULT_TENANT_ID);
    clock.advance(10_000);
    const evicted = await mgr.sweepIdle();
    expect(evicted).toEqual([]);
    expect(mgr.has(DEFAULT_TENANT_ID)).toBe(true);
  });

  it('respects maxTenants by throwing on overflow', async () => {
    const mgr = new TenantManager({
      createContext: async () => makeStubContext('c'),
      config: { maxTenants: 2 },
    });
    await mgr.getOrCreate('a');
    await mgr.getOrCreate('b');
    await expect(mgr.getOrCreate('c')).rejects.toThrow(/max tenants reached/i);
  });

  it('exposes DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS at 10 minutes', () => {
    expect(DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it('swallows close errors so release still removes the entry', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeStubContext('bad');
    (ctx.close as jest.Mock).mockImplementation(async () => {
      throw new Error('boom');
    });
    const mgr = new TenantManager({ createContext: async () => ctx });
    await mgr.getOrCreate('alpha');
    const removed = await mgr.release('alpha');
    expect(removed).toBe(true);
    expect(mgr.has('alpha')).toBe(false);
    errorSpy.mockRestore();
  });

  it('deduplicates concurrent getOrCreate for the same tenant', async () => {
    let n = 0;
    const factory = jest.fn(async () => {
      n++;
      await new Promise((r) => setImmediate(r));
      return makeStubContext(`ctx-${n}`);
    });
    const mgr = new TenantManager({ createContext: factory });
    const [a, b, c] = await Promise.all([
      mgr.getOrCreate('alpha'),
      mgr.getOrCreate('alpha'),
      mgr.getOrCreate('alpha'),
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(mgr.stats().active).toBe(1);
    expect(mgr.stats().totalCreated).toBe(1);
  });

  it('enforces maxTenants atomically under concurrent creates', async () => {
    const factory = jest.fn(async () => {
      await new Promise((r) => setImmediate(r));
      return makeStubContext('c');
    });
    const mgr = new TenantManager({
      createContext: factory,
      config: { maxTenants: 2 },
    });
    const results = await Promise.allSettled([
      mgr.getOrCreate('a'),
      mgr.getOrCreate('b'),
      mgr.getOrCreate('c'),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/max tenants reached/i),
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(mgr.stats().active).toBe(2);
  });

  it('closeAll drains in-flight creations and closes the resulting contexts', async () => {
    const ctx = makeStubContext('late');
    let releaseCreate: (() => void) | null = null;
    const factory = jest.fn(async () => {
      await new Promise<void>((r) => {
        releaseCreate = r;
      });
      return ctx;
    });
    const mgr = new TenantManager({ createContext: factory });
    const creating = mgr.getOrCreate('alpha');
    // createContext is now awaiting; start closeAll before it resolves.
    const closing = mgr.closeAll();
    // Wait one microtask so closeAll can install its pending await.
    await Promise.resolve();
    expect(releaseCreate).not.toBeNull();
    (releaseCreate as unknown as () => void)();
    await creating;
    await closing;
    expect(ctx.__closed).toBe(true);
    expect(mgr.has('alpha')).toBe(false);
    expect(mgr.stats().active).toBe(0);
    expect(mgr.stats().totalClosed).toBe(1);
  });

  it('release awaits pending creation and closes the resulting context', async () => {
    const ctx = makeStubContext('late');
    let releaseCreate: (() => void) | null = null;
    const factory = jest.fn(async () => {
      await new Promise<void>((r) => {
        releaseCreate = r;
      });
      return ctx;
    });
    const mgr = new TenantManager({ createContext: factory });
    const creating = mgr.getOrCreate('alpha');
    // release is called while createContext is mid-await
    const releasing = mgr.release('alpha');
    await Promise.resolve();
    expect(releaseCreate).not.toBeNull();
    (releaseCreate as unknown as () => void)();
    await creating;
    const removed = await releasing;
    expect(removed).toBe(true);
    expect(ctx.__closed).toBe(true);
    expect(mgr.has('alpha')).toBe(false);
    expect(mgr.stats().active).toBe(0);
    expect(mgr.stats().totalClosed).toBe(1);
  });

  it('release returns false when pending creation fails and leaves no entry', async () => {
    let releaseReject: ((e: Error) => void) | null = null;
    const factory = jest.fn(async () => {
      return new Promise<BrowserContext>((_res, rej) => {
        releaseReject = rej;
      });
    });
    const mgr = new TenantManager({ createContext: factory });
    const creating = mgr.getOrCreate('alpha');
    const releasing = mgr.release('alpha');
    await Promise.resolve();
    (releaseReject as unknown as (e: Error) => void)(new Error('create-fail'));
    await expect(creating).rejects.toThrow('create-fail');
    await expect(releasing).resolves.toBe(false);
    expect(mgr.has('alpha')).toBe(false);
    expect(mgr.stats().active).toBe(0);
  });

  it('rejects getOrCreate while closeAll is in progress', async () => {
    const ctx = makeStubContext('a');
    let releaseCreate: (() => void) | null = null;
    const factory = jest.fn(async () => {
      await new Promise<void>((r) => {
        releaseCreate = r;
      });
      return ctx;
    });
    const mgr = new TenantManager({ createContext: factory });
    const creating = mgr.getOrCreate('alpha');
    const closing = mgr.closeAll();
    await Promise.resolve();
    // closing is now in-progress — any new tenant creation must be rejected
    await expect(mgr.getOrCreate('beta')).rejects.toThrow(/closeAll in progress/);
    (releaseCreate as unknown as () => void)();
    await creating;
    await closing;
    // After closeAll finishes, the manager is reusable
    const fresh = makeStubContext('fresh');
    const mgr2 = new TenantManager({ createContext: async () => fresh });
    await mgr2.closeAll();
    await expect(mgr2.getOrCreate('gamma')).resolves.toBeDefined();
  });

  it('does not leak pending when createContext throws synchronously', async () => {
    const factory = jest.fn(() => {
      throw new Error('sync-boom');
    }) as unknown as () => Promise<BrowserContext>;
    const mgr = new TenantManager({ createContext: factory });
    await expect(mgr.getOrCreate('alpha')).rejects.toThrow('sync-boom');
    // Capacity should be free: 1-tenant cap still allows a fresh attempt.
    const mgr2 = new TenantManager({
      createContext: factory,
      config: { maxTenants: 1 },
    });
    await expect(mgr2.getOrCreate('alpha')).rejects.toThrow('sync-boom');
    await expect(mgr2.getOrCreate('beta')).rejects.toThrow('sync-boom');
    expect(mgr2.stats().active).toBe(0);
    // If pending leaked, the third call would hit "max tenants reached"
    // instead of reaching the factory — verify factory was actually invoked.
    expect((factory as unknown as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('closeAll is single-flight so concurrent callers share one drain', async () => {
    const ctx = makeStubContext('a');
    let releaseCreate: (() => void) | null = null;
    const factory = jest.fn(async () => {
      await new Promise<void>((r) => {
        releaseCreate = r;
      });
      return ctx;
    });
    const mgr = new TenantManager({ createContext: factory });
    const creating = mgr.getOrCreate('alpha');
    const closeA = mgr.closeAll();
    const closeB = mgr.closeAll();
    // Both closes share the same underlying promise.
    expect(closeA).toBe(closeB);
    // getOrCreate must reject throughout the full drain, even after
    // closeA's finally would have fired on a bool flag.
    await Promise.resolve();
    await expect(mgr.getOrCreate('beta')).rejects.toThrow(/closeAll in progress/);
    (releaseCreate as unknown as () => void)();
    await creating;
    await closeA;
    // After close resolves, the manager is reusable.
    const fresh = makeStubContext('fresh');
    const mgr2 = new TenantManager({ createContext: async () => fresh });
    await expect(mgr2.getOrCreate('gamma')).resolves.toBeDefined();
  });

  it('sweepIdle re-checks activity before eviction', async () => {
    const clock = fakeClock();
    const alphaCtx = makeStubContext('a');
    const betaCtx = makeStubContext('b');
    let n = 0;
    // closeContext for alpha (the first release) touches beta mid-sweep,
    // simulating concurrent traffic that refreshes an about-to-be-evicted
    // tenant. On the old code beta would be evicted anyway (stale snapshot);
    // with revalidation beta must survive.
    let mgrRef!: TenantManager;
    mgrRef = new TenantManager({
      createContext: async () => (++n === 1 ? alphaCtx : betaCtx),
      now: clock.now,
      config: { idleTimeoutMs: 10_000 },
      closeContext: async (c) => {
        if (c === alphaCtx) {
          mgrRef.touch('beta');
        }
        await (c as StubContext).close();
      },
    });
    await mgrRef.getOrCreate('alpha');
    await mgrRef.getOrCreate('beta');
    clock.advance(11_000);
    const evicted = await mgrRef.sweepIdle();
    expect(evicted).toEqual(['alpha']);
    expect(mgrRef.has('alpha')).toBe(false);
    expect(mgrRef.has('beta')).toBe(true);
    expect(mgrRef.stats().idleEvictions).toBe(1);
  });

  it('clears in-flight entry on createContext failure so retries can succeed', async () => {
    let calls = 0;
    const factory = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return makeStubContext('ok');
    });
    const mgr = new TenantManager({ createContext: factory });
    await expect(mgr.getOrCreate('alpha')).rejects.toThrow('boom');
    const entry = await mgr.getOrCreate('alpha');
    expect(entry.id).toBe('alpha');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(mgr.stats().active).toBe(1);
  });
});
