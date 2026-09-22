jest.unmock('puppeteer-core');

import puppeteer, { Browser } from 'puppeteer-core';
import { createBackgroundPage } from '../../src/cdp/background-page';

const executablePath = process.env.OPENCHROME_TEST_CHROME;
const browserTests = executablePath ? describe : describe.skip;

browserTests('background creation against real Chrome', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath, headless: process.env.OPENCHROME_TEST_HEADED !== '1', defaultViewport: null });
  });
  afterAll(async () => { await browser?.close(); });

  it('preserves the active tab when creating a default-context page', async () => {
    const original = (await browser.pages())[0];
    await original.bringToFront();
    const page = await createBackgroundPage(browser);
    expect(await original.evaluate(() => document.visibilityState)).toBe('visible');
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
    expect(page.browserContext()).toBe(browser.defaultBrowserContext());
    await page.close();
  });

  it('creates distinct targets for concurrent requests', async () => {
    const pages = await Promise.all(Array.from({ length: 4 }, () => createBackgroundPage(browser)));
    expect(new Set(pages).size).toBe(4);
    expect(await Promise.all(pages.map(page => page.evaluate(() => document.visibilityState)))).toEqual(['hidden', 'hidden', 'hidden', 'hidden']);
    await Promise.all(pages.map(page => page.close()));
  });

  it('retains explicitly selected context isolation', async () => {
    const context = await browser.createBrowserContext();
    const page = await createBackgroundPage(browser, context);
    expect(page.browserContext()).toBe(context);
    expect(page.browserContext()).not.toBe(browser.defaultBrowserContext());
    await context.close();
  });

  it('does not fall back to another context when the requested context has closed', async () => {
    const context = await browser.createBrowserContext();
    await context.close();
    const before = (await browser.pages()).length;
    await expect(createBackgroundPage(browser, context)).rejects.toThrow();
    expect((await browser.pages()).length).toBe(before);
  });
});
