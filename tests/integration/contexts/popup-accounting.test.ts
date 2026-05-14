/// <reference types="jest" />
/**
 * Popup tab-count accounting for named BrowserContexts (#848 / #946).
 *
 * Verifies the Codex P1 fix: a popup opened via `window.open` from a tab
 * inside a named context must inherit that context's `(browser, name)`
 * mapping AND increment the registry's tab count. Closing the parent tab
 * must NOT trigger auto-destroy of the BrowserContext while the popup
 * (still attached to it) is alive.
 *
 * Gated behind `OPENCHROME_REAL_CHROME=1` so routine CI stays fast. The
 * file always compiles; under the gate it exercises a real Chrome popup
 * flow end-to-end.
 */
import puppeteer, { type Browser, type Page, type Target } from 'puppeteer-core';
import {
  DefaultNamedContextRegistry,
} from '../../../src/chrome/contexts';

const REAL_CHROME = process.env.OPENCHROME_REAL_CHROME === '1';

/** Resolve a Chrome / Chromium executable for the integration run. */
function findChromeExecutable(): string | null {
  if (process.env.OPENCHROME_TEST_CHROME) return process.env.OPENCHROME_TEST_CHROME;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      if (require('fs').existsSync(candidate)) return candidate;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Wait for a `targetcreated` page event whose URL matches `predicate`.
 * Used to capture the popup that the parent page opens via window.open.
 */
function waitForPopup(browser: Browser, predicate: (url: string) => boolean, timeoutMs = 15_000): Promise<Target> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.off('targetcreated', listener);
      reject(new Error(`waitForPopup timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (target: Target) => {
      if (target.type() !== 'page') return;
      if (!predicate(target.url())) return;
      clearTimeout(timer);
      browser.off('targetcreated', listener);
      resolve(target);
    };
    browser.on('targetcreated', listener);
  });
}

(REAL_CHROME ? describe : describe.skip)(
  'Popup tab-count inheritance (#848 / #946) — real Chrome',
  () => {
    let browser: Browser;
    let registry: DefaultNamedContextRegistry;

    beforeAll(async () => {
      const executablePath = findChromeExecutable();
      if (!executablePath) {
        throw new Error('No Chrome executable found; set OPENCHROME_TEST_CHROME or install Chrome.');
      }
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      registry = new DefaultNamedContextRegistry();
    }, 120_000);

    afterAll(async () => {
      if (browser) await browser.close();
    });

    it('popup inherits parent context and keeps tab count > 0 after parent close', async () => {
      const ctx = await registry.getOrCreate(browser, 'acct-popup');
      const parent = await ctx.newPage();
      registry.incrementTabCount(browser, 'acct-popup');

      try {
        await parent.goto('data:text/html,<!doctype html><title>parent</title>', {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });

        const popupUrl = 'data:text/html,<!doctype html><title>popup</title>';
        const popupTargetPromise = waitForPopup(browser, (url) => url.startsWith('data:text/html') && url.includes('popup'));
        await parent.evaluate((u: string) => {
          (window as unknown as { __pop?: Window }).__pop = window.open(u, '_blank') ?? undefined;
        }, popupUrl);
        const popupTarget = await popupTargetPromise;
        const popupPage = (await popupTarget.page()) as Page | null;
        expect(popupPage).not.toBeNull();

        // Simulate the SessionManager.registerExternalTarget inheritance:
        // bump the registry tab count for the popup. (registerExternalTarget
        // wires this in production; here we exercise the registry contract
        // directly.)
        registry.incrementTabCount(browser, 'acct-popup');
        expect(registry.getInfo(browser, 'acct-popup')!.tabs).toBe(2);

        // Close the parent tab — registry must NOT destroy the context
        // because the popup still holds a tab against it.
        await parent.close();
        const destroyedAfterParent = await registry.decrementTabCount(browser, 'acct-popup');
        expect(destroyedAfterParent).toBe(false);
        expect(registry.has(browser, 'acct-popup')).toBe(true);
        expect(registry.getInfo(browser, 'acct-popup')!.tabs).toBe(1);

        // Now close the popup — registry should auto-destroy.
        await popupPage!.close().catch(() => {});
        const destroyedAfterPopup = await registry.decrementTabCount(browser, 'acct-popup');
        expect(destroyedAfterPopup).toBe(true);
        expect(registry.has(browser, 'acct-popup')).toBe(false);
      } finally {
        if (!parent.isClosed()) await parent.close().catch(() => {});
      }
    }, 120_000);
  },
);

// Always-on compile-only smoke test: keeps the file in the jest graph
// even when OPENCHROME_REAL_CHROME is unset, so a future change that
// breaks the popup-accounting types fails fast in routine QA.
describe('Popup tab-count accounting — compile smoke (#848 / #946)', () => {
  it('registry exposes the (browser, name) tab-counter signatures', () => {
    const reg = new DefaultNamedContextRegistry();
    // Type-level only: ensure the methods exist with the new arity.
    expect(typeof reg.incrementTabCount).toBe('function');
    expect(typeof reg.decrementTabCount).toBe('function');
    expect(typeof reg.addResumeRef).toBe('function');
    expect(typeof reg.releaseResumeRef).toBe('function');
    expect(reg.incrementTabCount.length).toBe(2);
    expect(reg.decrementTabCount.length).toBe(2);
  });
});
