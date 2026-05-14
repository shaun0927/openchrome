/// <reference types="jest" />

import {
  PlaywrightAdapter,
  PlaywrightBrowserLike,
  PlaywrightContextLike,
  PlaywrightPageLike,
} from './playwright-adapter';

/** Mock Playwright browser/context/page tree that records driven operations. */
function makeMockBrowser(opts: { pageHtml?: string; withExistingContext?: boolean } = {}): {
  browser: PlaywrightBrowserLike;
  log: string[];
  closed: () => boolean;
} {
  const log: string[] = [];
  let browserClosed = false;
  let pageSeq = 0;

  const makeContext = (): PlaywrightContextLike => ({
    async newPage(): Promise<PlaywrightPageLike> {
      const id = ++pageSeq;
      log.push(`newPage:${id}`);
      return {
        async goto(url: string) {
          log.push(`goto:${id}:${url}`);
        },
        async content() {
          log.push(`content:${id}`);
          return opts.pageHtml ?? `<html><body>page ${id}</body></html>`;
        },
        async close() {
          log.push(`close:${id}`);
        },
      };
    },
  });

  const existing = opts.withExistingContext === false ? [] : [makeContext()];
  const browser: PlaywrightBrowserLike = {
    contexts: () => existing,
    async newContext() {
      log.push('newContext');
      return makeContext();
    },
    async close() {
      browserClosed = true;
    },
  };
  return { browser, log, closed: () => browserClosed };
}

function adapterWithMock(opts: { pageHtml?: string; withExistingContext?: boolean } = {}) {
  const mock = makeMockBrowser(opts);
  const adapter = new PlaywrightAdapter({ connect: async () => mock.browser });
  return { adapter, ...mock };
}

describe('PlaywrightAdapter', () => {
  test('conforms to the LibraryAdapter identity contract', () => {
    const adapter = new PlaywrightAdapter();
    expect(adapter.name).toBe('Playwright');
    expect(adapter.kind).toBe('library');
    expect(adapter.mode).toBe('raw-html');
  });

  test('callTool before setup() reports an error result, does not throw', async () => {
    const adapter = new PlaywrightAdapter({ connect: async () => makeMockBrowser().browser });
    const res = await adapter.callTool('read_page', { tabId: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('setup() was not called');
  });

  test('setup reuses the existing CDP browser context', async () => {
    const { adapter, log } = adapterWithMock();
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'about:blank' });
    // newPage came from the existing context — newContext was never called.
    expect(log).not.toContain('newContext');
    expect(log).toContain('newPage:1');
  });

  test('setup falls back to newContext when none exists', async () => {
    const { adapter, log } = adapterWithMock({ withExistingContext: false });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'about:blank' });
    expect(log).toContain('newContext');
  });

  test('tabs_create opens a page, navigates, and returns a tabId', async () => {
    const { adapter, log } = adapterWithMock();
    await adapter.setup();
    const res = await adapter.callTool('tabs_create', { url: 'http://127.0.0.1/small' });
    const tabId = JSON.parse(res.content[0].text as string).tabId;
    expect(tabId).toMatch(/^playwright-tab-\d+$/);
    expect(log).toContain('goto:1:http://127.0.0.1/small');
    expect(adapter.openTabCount).toBe(1);
  });

  test('about:blank is not navigated to', async () => {
    const { adapter, log } = adapterWithMock();
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'about:blank' });
    expect(log.some((l) => l.startsWith('goto:'))).toBe(false);
  });

  test('read_page returns the page raw HTML for the given tabId', async () => {
    const { adapter } = adapterWithMock({ pageHtml: '<html><body>fixture</body></html>' });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId, mode: 'dom' });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toBe('<html><body>fixture</body></html>');
  });

  test('read_page on an unknown tabId is an error result', async () => {
    const { adapter } = adapterWithMock();
    await adapter.setup();
    const res = await adapter.callTool('read_page', { tabId: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unknown tabId');
  });

  test('tabs_close closes the page and drops it from the tab map', async () => {
    const { adapter, log } = adapterWithMock();
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    await adapter.callTool('tabs_close', { tabId });
    expect(log).toContain('close:1');
    expect(adapter.openTabCount).toBe(0);
  });

  test('unsupported tools return an error result rather than throwing', async () => {
    const { adapter } = adapterWithMock();
    await adapter.setup();
    const res = await adapter.callTool('act', { instruction: 'click' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unsupported tool');
  });

  test('teardown closes remaining pages and the browser', async () => {
    const { adapter, log, closed } = adapterWithMock();
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.callTool('tabs_create', { url: 'http://x/b' });
    await adapter.teardown();
    expect(log.filter((l) => l.startsWith('close:'))).toHaveLength(2);
    expect(closed()).toBe(true);
    expect(adapter.openTabCount).toBe(0);
  });
});
