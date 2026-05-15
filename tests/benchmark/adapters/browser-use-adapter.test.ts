/// <reference types="jest" />

import {
  BrowserUseAdapter,
  BrowserUseBridgeTransport,
} from './browser-use-adapter';

/** Mock bridge transport that records calls and returns canned responses. */
function makeMockTransport(opts: {
  /** Forced sleep before each response — used to verify bridgeOverheadMs accounting. */
  perCallDelayMs?: number;
  /** Force a specific bridge method to return ok=false. */
  failOn?: string;
} = {}): {
  transport: BrowserUseBridgeTransport;
  sent: Array<{ method: string; args: Record<string, unknown> }>;
  started: () => boolean;
  stopped: () => boolean;
} {
  const sent: Array<{ method: string; args: Record<string, unknown> }> = [];
  let started = false;
  let stopped = false;
  let tabSeq = 0;

  const transport: BrowserUseBridgeTransport = {
    async start() {
      started = true;
    },
    async send(req) {
      sent.push({ method: req.method, args: req.args });
      if (opts.perCallDelayMs) {
        await new Promise((r) => setTimeout(r, opts.perCallDelayMs));
      }
      if (opts.failOn === req.method) {
        return { id: req.id, ok: false, error: `mocked failure for ${req.method}` };
      }
      switch (req.method) {
        case 'ping':
          return { id: req.id, ok: true, result: { pong: true } };
        case 'open_tab': {
          tabSeq += 1;
          return { id: req.id, ok: true, result: { tabId: `browser-use-tab-${tabSeq}` } };
        }
        case 'read_page':
          return { id: req.id, ok: true, result: { payload: `dom for ${req.args.tabId}` } };
        case 'close_tab':
          return { id: req.id, ok: true, result: { closed: req.args.tabId } };
        case 'shutdown':
          return { id: req.id, ok: true, result: { shutdown: true } };
        default:
          return { id: req.id, ok: false, error: `unsupported ${req.method}` };
      }
    },
    async stop() {
      stopped = true;
    },
  };

  return { transport, sent, started: () => started, stopped: () => stopped };
}

describe('BrowserUseAdapter', () => {
  test('conforms to the LibraryAdapter identity contract', () => {
    const adapter = new BrowserUseAdapter();
    expect(adapter.name).toBe('browser-use');
    expect(adapter.kind).toBe('bridge');
    expect(adapter.mode).toBe('dom-serialization');
  });

  test('callTool before setup() returns an error result, does not throw', async () => {
    const adapter = new BrowserUseAdapter();
    const res = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('setup() was not called');
  });

  test('setup starts the injected transport', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    expect(mock.started()).toBe(true);
  });

  test('tabs_create routes through bridge.open_tab and returns the bridge tabId', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    expect(res.isError).toBeFalsy();
    const tabId = JSON.parse(res.content[0].text as string).tabId;
    expect(tabId).toMatch(/^browser-use-tab-\d+$/);
    expect(mock.sent.map((s) => s.method)).toEqual(['open_tab']);
    expect(mock.sent[0].args).toEqual({ url: 'http://x/p' });
  });

  test('read_page routes through bridge.read_page and returns its payload', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toBe(`dom for ${tabId}`);
  });

  test('tabs_close routes through bridge.close_tab', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    await adapter.callTool('tabs_close', { tabId });
    const methods = mock.sent.map((s) => s.method);
    expect(methods).toEqual(['open_tab', 'close_tab']);
  });

  test('bridge errors surface as error results rather than throwing', async () => {
    const mock = makeMockTransport({ failOn: 'open_tab' });
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mocked failure for open_tab');
  });

  test('unsupported tools return an error result rather than throwing', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('act', { instruction: 'click' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unsupported tool');
  });

  test('bridgeOverheadMs is tracked separately and reflects real round-trip time', async () => {
    const mock = makeMockTransport({ perCallDelayMs: 30 });
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    expect(adapter.bridgeOverheadMs).toBe(0);
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.callTool('tabs_create', { url: 'http://x/b' });
    // Two 30ms calls minimum; allow generous slack for slow CI runners.
    expect(adapter.bridgeOverheadMs).toBeGreaterThanOrEqual(50);
  });

  test('bridge overhead never appears in the MCPToolResult content payload', async () => {
    // Critical isolation guard: a competitor would (rightly) flag any
    // contamination of token / success metrics with subprocess overhead.
    const mock = makeMockTransport({ perCallDelayMs: 10 });
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const createdText = String(created.content[0].text);
    expect(createdText).not.toMatch(/bridgeOverhead|overheadMs|elapsed|recvMonotonicNs/i);

    const tabId = JSON.parse(createdText).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    const readText = String(read.content[0].text);
    expect(readText).not.toMatch(/bridgeOverhead|overheadMs|elapsed|recvMonotonicNs/i);
    // And the adapter property is the *only* place overhead appears.
    expect(adapter.bridgeOverheadMs).toBeGreaterThan(0);
  });

  test('tabs_close on a tabId the bridge does not recognize surfaces as an error result', async () => {
    const mock = makeMockTransport({ failOn: 'close_tab' });
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('tabs_close', { tabId: 'never-opened' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('mocked failure for close_tab');
  });

  test('teardown resets bridgeOverheadMs so a reused adapter does not double-count', async () => {
    const mock = makeMockTransport({ perCallDelayMs: 15 });
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    expect(adapter.bridgeOverheadMs).toBeGreaterThan(0);
    await adapter.teardown();
    expect(adapter.bridgeOverheadMs).toBe(0);
  });

  test('teardown sends shutdown and stops the transport', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserUseAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.teardown();
    expect(mock.stopped()).toBe(true);
    const methods = mock.sent.map((s) => s.method);
    expect(methods[methods.length - 1]).toBe('shutdown');
  });
});
