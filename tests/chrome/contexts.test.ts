/**
 * Unit tests for NamedContextRegistry (#848).
 *
 * The puppeteer-core `Browser` and `BrowserContext` are stubbed so the
 * test runs without a real Chrome — only the registry's bookkeeping
 * (mint, lookup, name validation, lifecycle, resume-pin) is exercised.
 */

import {
  DefaultNamedContextRegistry,
  InvalidContextNameError,
  ContextHasActiveTabsError,
  assertValidContextName,
  DEFAULT_CONTEXT_NAME,
} from '../../src/chrome/contexts';

interface FakeContext {
  id: number;
  closed: boolean;
  close(): Promise<void>;
}

interface FakeBrowser {
  contexts: FakeContext[];
  createBrowserContext(): Promise<FakeContext>;
  browserContexts(): FakeContext[];
}

function makeFakeBrowser(): FakeBrowser {
  let nextId = 1;
  const browser: FakeBrowser = {
    contexts: [],
    async createBrowserContext() {
      const ctx: FakeContext = {
        id: nextId++,
        closed: false,
        async close() {
          this.closed = true;
          browser.contexts = browser.contexts.filter((c) => c !== this);
        },
      };
      browser.contexts.push(ctx);
      return ctx;
    },
    browserContexts() {
      return [...browser.contexts];
    },
  };
  return browser;
}

describe('NamedContextRegistry — name validation (#848)', () => {
  it('accepts simple names', () => {
    expect(() => assertValidContextName('acct-A')).not.toThrow();
    expect(() => assertValidContextName('acct_A')).not.toThrow();
    expect(() => assertValidContextName('A')).not.toThrow();
    expect(() => assertValidContextName('a'.repeat(64))).not.toThrow();
  });

  it('rejects malformed names', () => {
    expect(() => assertValidContextName('')).toThrow(InvalidContextNameError);
    expect(() => assertValidContextName('has space')).toThrow(InvalidContextNameError);
    expect(() => assertValidContextName('has/slash')).toThrow(InvalidContextNameError);
    expect(() => assertValidContextName('emoji-😀')).toThrow(InvalidContextNameError);
    expect(() => assertValidContextName('a'.repeat(65))).toThrow(InvalidContextNameError);
  });

  it('rejects the reserved "default" name', () => {
    expect(() => assertValidContextName(DEFAULT_CONTEXT_NAME)).toThrow(InvalidContextNameError);
  });

  it('is case-sensitive (Acct vs acct are different)', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const a = await reg.getOrCreate(browser as any, 'Acct');
    const b = await reg.getOrCreate(browser as any, 'acct');
    expect(a).not.toBe(b);
    expect(reg.list().map((e) => e.name).sort()).toEqual(['Acct', 'acct']);
  });
});

describe('NamedContextRegistry — getOrCreate (#848)', () => {
  it('mints a new BrowserContext on first request', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const ctx = await reg.getOrCreate(browser as any, 'tenant-1');
    expect(browser.contexts).toHaveLength(1);
    expect(ctx).toBe(browser.contexts[0]);
  });

  it('reuses the existing BrowserContext on subsequent calls', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const a = await reg.getOrCreate(browser as any, 'tenant-1');
    const b = await reg.getOrCreate(browser as any, 'tenant-1');
    expect(a).toBe(b);
    expect(browser.contexts).toHaveLength(1);
  });

  it('coalesces concurrent creation requests for the same name', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const [a, b, c] = await Promise.all([
      reg.getOrCreate(browser as any, 'tenant-1'),
      reg.getOrCreate(browser as any, 'tenant-1'),
      reg.getOrCreate(browser as any, 'tenant-1'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(browser.contexts).toHaveLength(1);
  });

  it('mints a fresh context when the previous Chrome was rotated', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await reg.getOrCreate(browser as any, 'tenant-1');
    // Simulate Chrome restart: the recorded context is no longer in the
    // browser's `browserContexts()` list.
    browser.contexts = [];
    const next = await reg.getOrCreate(browser as any, 'tenant-1');
    expect(browser.contexts).toContain(next);
  });
});

describe('NamedContextRegistry — list (#848)', () => {
  it('reports tab counts and createdAt', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await reg.getOrCreate(browser as any, 'A');
    await reg.getOrCreate(browser as any, 'B');
    reg.incrementTabCount(browser as any, 'A');
    reg.incrementTabCount(browser as any, 'A');
    reg.incrementTabCount(browser as any, 'B');

    const list = reg.list();
    expect(list).toHaveLength(2);
    const a = list.find((e) => e.name === 'A')!;
    const b = list.find((e) => e.name === 'B')!;
    expect(a.tabs).toBe(2);
    expect(b.tabs).toBe(1);
    expect(a.createdAt).toBeGreaterThan(0);
  });

  it('filters by browser when one is provided', async () => {
    const reg = new DefaultNamedContextRegistry();
    const b1 = makeFakeBrowser();
    const b2 = makeFakeBrowser();
    await reg.getOrCreate(b1 as any, 'shared');
    await reg.getOrCreate(b2 as any, 'shared');
    expect(reg.list().map((e) => e.name).sort()).toEqual(['shared', 'shared']);
    expect(reg.list(b1 as any).map((e) => e.name)).toEqual(['shared']);
    expect(reg.list(b2 as any).map((e) => e.name)).toEqual(['shared']);
  });
});

describe('NamedContextRegistry — lifecycle (#848)', () => {
  it('auto-destroys context when last tab closes and no resume pin', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const ctx = await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount(browser as any, 'A');
    expect(reg.has(browser as any, 'A')).toBe(true);

    const destroyed = await reg.decrementTabCount(browser as any, 'A');
    expect(destroyed).toBe(true);
    expect(reg.has(browser as any, 'A')).toBe(false);
    expect((ctx as unknown as FakeContext).closed).toBe(true);
  });

  it('keeps the context alive while a resume pin is active', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount(browser as any, 'A');
    reg.addResumeRef(browser as any, 'A');

    const destroyedAfterTabClose = await reg.decrementTabCount(browser as any, 'A');
    expect(destroyedAfterTabClose).toBe(false);
    expect(reg.has(browser as any, 'A')).toBe(true);

    const destroyedAfterPinRelease = await reg.releaseResumeRef(browser as any, 'A');
    expect(destroyedAfterPinRelease).toBe(true);
    expect(reg.has(browser as any, 'A')).toBe(false);
  });

  it('explicit close() rejects when tabs are still open', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount(browser as any, 'A');
    await expect(reg.close(browser as any, 'A')).rejects.toBeInstanceOf(ContextHasActiveTabsError);
    expect(reg.has(browser as any, 'A')).toBe(true);
  });

  it('explicit close({force:true}) destroys regardless of tab count', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const ctx = await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount(browser as any, 'A');
    await reg.close(browser as any, 'A', { force: true });
    expect(reg.has(browser as any, 'A')).toBe(false);
    expect((ctx as unknown as FakeContext).closed).toBe(true);
  });

  it('close() on unknown name is a no-op', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await expect(reg.close(browser as any, 'does-not-exist')).resolves.toBeUndefined();
  });

  it('decrementTabCount on unknown name is a no-op', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await expect(reg.decrementTabCount(browser as any, 'does-not-exist')).resolves.toBe(false);
  });
});

/**
 * Codex P1 (#946 review): the registry must key entries by
 * `(browserInstanceId, name)`, not by name alone. Reusing the same
 * isolatedContext name on a separate Chrome instance must produce a
 * distinct BrowserContext, and closing one must not tear down the other.
 */
describe('NamedContextRegistry — same name across different browsers (#848 / #946)', () => {
  it('mints distinct contexts when the same name is used on two browsers', async () => {
    const reg = new DefaultNamedContextRegistry();
    const b1 = makeFakeBrowser();
    const b2 = makeFakeBrowser();

    const c1 = await reg.getOrCreate(b1 as any, 'shared');
    const c2 = await reg.getOrCreate(b2 as any, 'shared');

    expect(c1).not.toBe(c2);
    expect(b1.contexts).toHaveLength(1);
    expect(b2.contexts).toHaveLength(1);
    expect(reg.has(b1 as any, 'shared')).toBe(true);
    expect(reg.has(b2 as any, 'shared')).toBe(true);
  });

  it('closing one browser\'s entry leaves the other browser\'s entry alive', async () => {
    const reg = new DefaultNamedContextRegistry();
    const b1 = makeFakeBrowser();
    const b2 = makeFakeBrowser();

    const c1 = await reg.getOrCreate(b1 as any, 'shared');
    const c2 = await reg.getOrCreate(b2 as any, 'shared');

    await reg.close(b1 as any, 'shared');

    expect(reg.has(b1 as any, 'shared')).toBe(false);
    expect((c1 as unknown as FakeContext).closed).toBe(true);

    expect(reg.has(b2 as any, 'shared')).toBe(true);
    expect((c2 as unknown as FakeContext).closed).toBe(false);
  });

  it('decrementTabCount targets the correct browser when names collide', async () => {
    const reg = new DefaultNamedContextRegistry();
    const b1 = makeFakeBrowser();
    const b2 = makeFakeBrowser();

    const c1 = await reg.getOrCreate(b1 as any, 'shared');
    const c2 = await reg.getOrCreate(b2 as any, 'shared');
    reg.incrementTabCount(b1 as any, 'shared');
    reg.incrementTabCount(b2 as any, 'shared');
    reg.incrementTabCount(b2 as any, 'shared'); // b2 holds 2 tabs

    const destroyed1 = await reg.decrementTabCount(b1 as any, 'shared');
    expect(destroyed1).toBe(true);
    expect((c1 as unknown as FakeContext).closed).toBe(true);

    // b2 still has tabs — must remain alive
    expect(reg.has(b2 as any, 'shared')).toBe(true);
    expect((c2 as unknown as FakeContext).closed).toBe(false);
    expect(reg.getInfo(b2 as any, 'shared')!.tabs).toBe(2);
  });
});
