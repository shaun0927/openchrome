/// <reference types="jest" />

import {
  PlaywrightMcpAdapter,
  PlaywrightMcpTransport,
} from './playwright-mcp-adapter';
import { MCPToolResult } from '../benchmark-runner';

/** Mock transport that records calls and returns canned responses. */
function makeMockTransport(opts: { snapshot?: string } = {}): {
  transport: PlaywrightMcpTransport;
  log: Array<{ tool: string; args: Record<string, unknown> }>;
  started: () => boolean;
  stopped: () => boolean;
} {
  const log: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let started = false;
  let stopped = false;

  const transport: PlaywrightMcpTransport = {
    async start() {
      started = true;
    },
    async callTool(toolName, args): Promise<MCPToolResult> {
      log.push({ tool: toolName, args });
      switch (toolName) {
        case 'browser_navigate':
          return { content: [{ type: 'text', text: 'navigated' }] };
        case 'browser_tab_new':
          return { content: [{ type: 'text', text: 'tab opened' }] };
        case 'browser_tab_select':
          return { content: [{ type: 'text', text: 'tab selected' }] };
        case 'browser_snapshot':
          return {
            content: [
              { type: 'text', text: opts.snapshot ?? '- page:\n  - heading "Fixture"' },
            ],
          };
        case 'browser_tab_close':
          return { content: [{ type: 'text', text: 'tab closed' }] };
        default:
          return { content: [{ type: 'text', text: `unsupported ${toolName}` }], isError: true };
      }
    },
    async stop() {
      stopped = true;
    },
  };

  return { transport, log, started: () => started, stopped: () => stopped };
}

describe('PlaywrightMcpAdapter', () => {
  test('conforms to the LibraryAdapter identity contract', () => {
    const adapter = new PlaywrightMcpAdapter();
    expect(adapter.name).toBe('playwright-mcp');
    expect(adapter.kind).toBe('mcp');
    expect(adapter.mode).toBe('a11y-snapshot');
  });

  test('callTool before setup() returns an error result, does not throw', async () => {
    const adapter = new PlaywrightMcpAdapter();
    const res = await adapter.callTool('read_page', { tabId: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('setup() was not called');
  });

  test('setup() starts the injected transport', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    expect(mock.started()).toBe(true);
  });

  test('tabs_create on first call uses browser_navigate and returns a tabId', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('tabs_create', { url: 'http://127.0.0.1/p' });
    expect(res.isError).toBeFalsy();
    const tabId = JSON.parse(res.content[0].text as string).tabId;
    expect(tabId).toMatch(/^playwright-mcp-tab-\d+$/);
    expect(mock.log.map((c) => c.tool)).toEqual(['browser_navigate']);
    expect(mock.log[0].args).toEqual({ url: 'http://127.0.0.1/p' });
    expect(adapter.openTabCount).toBe(1);
  });

  test('tabs_create on subsequent calls uses browser_tab_new', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.callTool('tabs_create', { url: 'http://x/b' });
    const tools = mock.log.map((c) => c.tool);
    expect(tools).toEqual(['browser_navigate', 'browser_tab_new']);
    expect(adapter.openTabCount).toBe(2);
  });

  test('about:blank does not trigger a navigation', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'about:blank' });
    // First-tab path is taken but browser_navigate is suppressed for about:blank.
    expect(mock.log.map((c) => c.tool)).toEqual([]);
    expect(adapter.openTabCount).toBe(1);
  });

  test('read_page returns the accessibility-snapshot text for the given tabId', async () => {
    const mock = makeMockTransport({ snapshot: '- page:\n  - heading "Fixture"' });
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toBe('- page:\n  - heading "Fixture"');
    // Single-tab read does NOT call browser_tab_select (no need to switch).
    expect(mock.log.some((c) => c.tool === 'browser_tab_select')).toBe(false);
  });

  test('read_page on the second tab routes through browser_tab_select first', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    const created2 = await adapter.callTool('tabs_create', { url: 'http://x/b' });
    const tabId2 = JSON.parse(created2.content[0].text as string).tabId;
    await adapter.callTool('read_page', { tabId: tabId2 });
    const tools = mock.log.map((c) => c.tool);
    expect(tools).toEqual([
      'browser_navigate',
      'browser_tab_new',
      'browser_tab_select',
      'browser_snapshot',
    ]);
  });

  test('read_page on an unknown tabId is an error result', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('read_page', { tabId: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unknown tabId');
  });

  test('closing a non-last tab renumbers higher-indexed tabs (playwright-mcp shifts them down)', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    // Open three tabs: indices 0, 1, 2.
    const t1 = await adapter.callTool('tabs_create', { url: 'http://x/a' });
    const t2 = await adapter.callTool('tabs_create', { url: 'http://x/b' });
    const t3 = await adapter.callTool('tabs_create', { url: 'http://x/c' });
    const id1 = JSON.parse(t1.content[0].text as string).tabId;
    const id2 = JSON.parse(t2.content[0].text as string).tabId;
    const id3 = JSON.parse(t3.content[0].text as string).tabId;

    // Close the middle tab (index 1). playwright-mcp now has two tabs at
    // indices 0 and 1; id3 was at 2 and must shift down to 1.
    await adapter.callTool('tabs_close', { tabId: id2 });
    mock.log.length = 0; // reset call log

    await adapter.callTool('read_page', { tabId: id3 });
    const selectAfterShift = mock.log.find((c) => c.tool === 'browser_tab_select');
    expect(selectAfterShift).toBeDefined();
    expect(selectAfterShift!.args).toEqual({ index: 1 });

    // id1 must still route to index 0.
    mock.log.length = 0;
    await adapter.callTool('read_page', { tabId: id1 });
    const selectFirst = mock.log.find((c) => c.tool === 'browser_tab_select');
    expect(selectFirst!.args).toEqual({ index: 0 });
  });

  test('teardown is idempotent — a second teardown does not throw', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.teardown();
    await expect(adapter.teardown()).resolves.toBeUndefined();
  });

  test('tabs_close closes the tab and drops it from the tab map', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    await adapter.callTool('tabs_close', { tabId });
    expect(mock.log.some((c) => c.tool === 'browser_tab_close')).toBe(true);
    expect(adapter.openTabCount).toBe(0);
  });

  test('unsupported tools return an error result rather than throwing', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const res = await adapter.callTool('act', { instruction: 'click' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unsupported tool');
  });

  test('teardown stops the transport and clears tab state', async () => {
    const mock = makeMockTransport();
    const adapter = new PlaywrightMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.callTool('tabs_create', { url: 'http://x/a' });
    await adapter.teardown();
    expect(mock.stopped()).toBe(true);
    expect(adapter.openTabCount).toBe(0);
  });
});
