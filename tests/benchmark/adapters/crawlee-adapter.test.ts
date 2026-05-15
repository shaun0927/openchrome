/// <reference types="jest" />

import { CrawleeAdapter, CrawleeExtractor } from './crawlee-adapter';

/** Mock extractor that records calls and returns canned extractions. */
function makeMockExtractor(opts: { text?: string; throwFor?: string } = {}): {
  extractor: CrawleeExtractor;
  log: string[];
  started: () => boolean;
  stopped: () => boolean;
} {
  const log: string[] = [];
  let started = false;
  let stopped = false;

  const extractor: CrawleeExtractor = {
    async start() {
      started = true;
    },
    async extract(url: string) {
      log.push(url);
      if (opts.throwFor && url === opts.throwFor) {
        throw new Error(`mocked extractor failure for ${url}`);
      }
      return { text: opts.text ?? `body text for ${url}` };
    },
    async stop() {
      stopped = true;
    },
  };
  return { extractor, log, started: () => started, stopped: () => stopped };
}

describe('CrawleeAdapter', () => {
  test('conforms to the LibraryAdapter identity contract', () => {
    const adapter = new CrawleeAdapter();
    expect(adapter.name).toBe('Crawlee');
    expect(adapter.kind).toBe('library');
    expect(adapter.mode).toBe('cheerio-text');
  });

  test('callTool before setup() returns an error result, does not throw', async () => {
    const adapter = new CrawleeAdapter();
    const res = await adapter.callTool('read_page', { tabId: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('setup() was not called');
  });

  test('setup starts the injected extractor', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    expect(mock.started()).toBe(true);
  });

  test('tabs_create registers a URL and returns a tabId without crawling yet', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const res = await adapter.callTool('tabs_create', { url: 'http://127.0.0.1/p' });
    const tabId = JSON.parse(res.content[0].text as string).tabId;
    expect(tabId).toMatch(/^crawlee-tab-\d+$/);
    expect(adapter.openTabCount).toBe(1);
    expect(mock.log).toEqual([]); // no crawl yet — lazy on read_page
  });

  test('read_page crawls on first call and returns the extracted text', async () => {
    const mock = makeMockExtractor({ text: 'hello world' });
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toBe('hello world');
    expect(mock.log).toEqual(['http://x/p']);
  });

  test('a second read_page on the same tab is cached — no second crawl', async () => {
    const mock = makeMockExtractor({ text: 'cached body' });
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    await adapter.callTool('read_page', { tabId });
    await adapter.callTool('read_page', { tabId });
    expect(mock.log).toEqual(['http://x/p']);
  });

  test('about:blank short-circuits to an empty body without invoking the extractor', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'about:blank' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toBe('');
    expect(mock.log).toEqual([]);
  });

  test('read_page on an unknown tabId is an error result', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const res = await adapter.callTool('read_page', { tabId: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unknown tabId');
  });

  test('extractor failure surfaces as an error result rather than throwing', async () => {
    const mock = makeMockExtractor({ throwFor: 'http://x/boom' });
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/boom' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    expect(read.isError).toBe(true);
    expect(read.content[0].text).toContain('mocked extractor failure');
  });

  test('tabs_close removes the tab from the registry and clears its cache', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    await adapter.callTool('read_page', { tabId });
    await adapter.callTool('tabs_close', { tabId });
    expect(adapter.openTabCount).toBe(0);
    const orphanRead = await adapter.callTool('read_page', { tabId });
    expect(orphanRead.isError).toBe(true);
  });

  test('unsupported tools return an error result rather than throwing', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    const res = await adapter.callTool('act', { instruction: 'click' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unsupported tool');
  });

  test('teardown stops the extractor and clears tab state', async () => {
    const mock = makeMockExtractor();
    const adapter = new CrawleeAdapter({ extractor: mock.extractor });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.teardown();
    expect(mock.stopped()).toBe(true);
    expect(adapter.openTabCount).toBe(0);
  });
});
