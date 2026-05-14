/// <reference types="jest" />

import {
  PuppeteerAdapter,
  PuppeteerBrowserLike,
  PuppeteerPageLike,
} from './puppeteer-adapter';

/** Mock Puppeteer browser/page tree that records the operations driven. */
function makeMockBrowser(opts: { pageHtml?: string } = {}): {
  browser: PuppeteerBrowserLike;
  log: string[];
  disconnected: () => boolean;
} {
  const log: string[] = [];
  let disconnected = false;
  let pageSeq = 0;
  const browser: PuppeteerBrowserLike = {
    async newPage(): Promise<PuppeteerPageLike> {
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
    async disconnect() {
      disconnected = true;
    },
  };
  return { browser, log, disconnected: () => disconnected };
}

function adapterWithMock(mockHtml?: string) {
  const mock = makeMockBrowser({ pageHtml: mockHtml });
  const adapter = new PuppeteerAdapter({ connect: async () => mock.browser });
  return { adapter, ...mock };
}

describe('PuppeteerAdapter', () => {
  test('conforms to the LibraryAdapter identity contract', () => {
    const adapter = new PuppeteerAdapter();
    expect(adapter.name).toBe('Puppeteer');
    expect(adapter.kind).toBe('library');
    expect(adapter.mode).toBe('raw-html');
  });

  test('callTool before setup() reports an error result, does not throw', async () => {
    const adapter = new PuppeteerAdapter({ connect: async () => makeMockBrowser().browser });
    const res = await adapter.callTool('read_page', { tabId: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('setup() was not called');
  });

  test('tabs_create opens a page, navigates, and returns a tabId', async () => {
    const { adapter, log } = adapterWithMock();
    await adapter.setup();
    const res = await adapter.callTool('tabs_create', { url: 'http://127.0.0.1/small' });
    const tabId = JSON.parse(res.content[0].text as string).tabId;
    expect(tabId).toMatch(/^puppeteer-tab-\d+$/);
    expect(log).toEqual(['newPage:1', 'goto:1:http://127.0.0.1/small']);
    expect(adapter.openTabCount).toBe(1);
  });

  test('about:blank is not navigated to (matches the OpenChrome adapters)', async () => {
    const { adapter, log } = adapterWithMock();
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'about:blank' });
    expect(log).toEqual(['newPage:1']); // no goto
  });

  test('read_page returns the page raw HTML for the given tabId', async () => {
    const { adapter } = adapterWithMock('<html><body>fixture</body></html>');
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

  test('teardown closes remaining pages and disconnects the browser', async () => {
    const { adapter, log, disconnected } = adapterWithMock();
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.callTool('tabs_create', { url: 'http://x/b' });
    await adapter.teardown();
    expect(log.filter((l) => l.startsWith('close:'))).toHaveLength(2);
    expect(disconnected()).toBe(true);
    expect(adapter.openTabCount).toBe(0);
  });
});
