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
    reg.incrementTabCount('A');
    reg.incrementTabCount('A');
    reg.incrementTabCount('B');

    const list = reg.list();
    expect(list).toHaveLength(2);
    const a = list.find((e) => e.name === 'A')!;
    const b = list.find((e) => e.name === 'B')!;
    expect(a.tabs).toBe(2);
    expect(b.tabs).toBe(1);
    expect(a.createdAt).toBeGreaterThan(0);
  });
});

describe('NamedContextRegistry — lifecycle (#848)', () => {
  it('auto-destroys context when last tab closes and no resume pin', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const ctx = await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount('A');
    expect(reg.has('A')).toBe(true);

    const destroyed = await reg.decrementTabCount('A');
    expect(destroyed).toBe(true);
    expect(reg.has('A')).toBe(false);
    expect((ctx as unknown as FakeContext).closed).toBe(true);
  });

  it('keeps the context alive while a resume pin is active', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount('A');
    reg.addResumeRef('A');

    const destroyedAfterTabClose = await reg.decrementTabCount('A');
    expect(destroyedAfterTabClose).toBe(false);
    expect(reg.has('A')).toBe(true);

    const destroyedAfterPinRelease = await reg.releaseResumeRef('A');
    expect(destroyedAfterPinRelease).toBe(true);
    expect(reg.has('A')).toBe(false);
  });

  it('explicit close() rejects when tabs are still open', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount('A');
    await expect(reg.close('A')).rejects.toBeInstanceOf(ContextHasActiveTabsError);
    expect(reg.has('A')).toBe(true);
  });

  it('explicit close({force:true}) destroys regardless of tab count', async () => {
    const reg = new DefaultNamedContextRegistry();
    const browser = makeFakeBrowser();
    const ctx = await reg.getOrCreate(browser as any, 'A');
    reg.incrementTabCount('A');
    await reg.close('A', { force: true });
    expect(reg.has('A')).toBe(false);
    expect((ctx as unknown as FakeContext).closed).toBe(true);
  });

  it('close() on unknown name is a no-op', async () => {
    const reg = new DefaultNamedContextRegistry();
    await expect(reg.close('does-not-exist')).resolves.toBeUndefined();
  });

  it('decrementTabCount on unknown name is a no-op', async () => {
    const reg = new DefaultNamedContextRegistry();
    await expect(reg.decrementTabCount('does-not-exist')).resolves.toBe(false);
  });
});
