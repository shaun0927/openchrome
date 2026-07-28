/// <reference types="jest" />

import path from 'node:path';
import {
  BROWSER_RS_PIN,
  BrowserRsMcpAdapter,
  BrowserRsMcpTransport,
  preflightBrowserRsBinary,
} from './browser-rs-mcp-adapter';
import { MCPToolResult } from '../benchmark-runner';

function makeMockTransport(opts: { navigate?: string; snapshot?: string; tools?: number } = {}): {
  transport: BrowserRsMcpTransport;
  log: Array<{ tool: string; args: Record<string, unknown> }>;
  initialized: () => boolean;
  listed: () => boolean;
  stopped: () => boolean;
} {
  const log: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let initialized = false;
  let listed = false;
  let stopped = false;

  const transport: BrowserRsMcpTransport = {
    command: ['browser-rs'],
    async start() {},
    async initialize() {
      initialized = true;
    },
    async listTools() {
      listed = true;
      return Array.from({ length: opts.tools ?? 64 }, (_, i) => ({ name: `browser_tool_${i}` }));
    },
    async callTool(toolName, args): Promise<MCPToolResult> {
      log.push({ tool: toolName, args });
      switch (toolName) {
        case 'browser_navigate':
          return { content: [{ type: 'text', text: opts.navigate ?? 'page p1\nurl http://x/p\n\n- page:\n  - heading "Fixture"' }] };
        case 'browser_snapshot':
          return { content: [{ type: 'text', text: opts.snapshot ?? 'page p1\n\n- page:\n  - heading "Fixture"' }] };
        case 'browser_close_page':
          return { content: [{ type: 'text', text: 'closed p1' }] };
        default:
          return { content: [{ type: 'text', text: `unsupported ${toolName}` }], isError: true };
      }
    },
    async stop() {
      stopped = true;
    },
  };

  return { transport, log, initialized: () => initialized, listed: () => listed, stopped: () => stopped };
}

describe('BrowserRsMcpAdapter', () => {
  test('conforms to the LibraryAdapter identity contract', () => {
    const adapter = new BrowserRsMcpAdapter({ transport: makeMockTransport().transport });
    expect(adapter.name).toBe('browser-rs-mcp');
    expect(adapter.kind).toBe('mcp');
    expect(adapter.mode).toBe('a11y-snapshot-stdio');
    expect(adapter.version).toBe(BROWSER_RS_PIN.version);
  });

  test('setup initializes MCP and records the descriptive tool count', async () => {
    const mock = makeMockTransport({ tools: 64 });
    const adapter = new BrowserRsMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    expect(mock.initialized()).toBe(true);
    expect(mock.listed()).toBe(true);
    expect(adapter.toolCount).toBe(64);
  });

  test('tabs_create navigates and exposes browser-rs page id as tabId', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserRsMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const result = await adapter.callTool('tabs_create', { url: 'http://127.0.0.1/p' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text as string)).toEqual({ tabId: 'p1' });
    expect(mock.log).toEqual([{ tool: 'browser_navigate', args: { url: 'http://127.0.0.1/p' } }]);
  });

  test('read_page snapshots the selected page id', async () => {
    const mock = makeMockTransport({ snapshot: 'page p1\n\n- page:\n  - button "Save"' });
    const adapter = new BrowserRsMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const read = await adapter.callTool('read_page', { tabId });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toContain('button "Save"');
    expect(mock.log.map((entry) => entry.tool)).toEqual(['browser_navigate', 'browser_snapshot']);
    expect(mock.log[1].args).toEqual({ page: 'p1' });
  });

  test('tabs_close closes the browser-rs page and clears adapter state', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserRsMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    const created = await adapter.callTool('tabs_create', { url: 'http://x/p' });
    const tabId = JSON.parse(created.content[0].text as string).tabId;
    const closed = await adapter.callTool('tabs_close', { tabId });
    expect(closed.isError).toBeFalsy();
    expect(mock.log.at(-1)).toEqual({ tool: 'browser_close_page', args: { page: 'p1' } });
    const readAfterClose = await adapter.callTool('read_page', { tabId });
    expect(readAfterClose.isError).toBe(true);
  });

  test('teardown stops the transport and is idempotent', async () => {
    const mock = makeMockTransport();
    const adapter = new BrowserRsMcpAdapter({ transport: mock.transport });
    await adapter.setup();
    await adapter.teardown();
    await expect(adapter.teardown()).resolves.toBeUndefined();
    expect(mock.stopped()).toBe(true);
  });

  test('callTool before setup returns an error result', async () => {
    const adapter = new BrowserRsMcpAdapter({ transport: makeMockTransport().transport });
    const result = await adapter.callTool('read_page', { tabId: 'p1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('setup() was not called');
  });

  test('unsupported tools return an error result', async () => {
    const adapter = new BrowserRsMcpAdapter({ transport: makeMockTransport().transport });
    await adapter.setup();
    const result = await adapter.callTool('act', { instruction: 'click' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unsupported tool');
  });
});

describe('preflightBrowserRsBinary', () => {
  const goodSha = BROWSER_RS_PIN.platforms['linux-x64'].sha256;
  const runnableDefaults = {
    platform: 'linux' as const,
    arch: 'x64' as const,
    resolveBinary: () => '/canonical/browser-rs',
    resolveChrome: () => '/canonical/google-chrome',
    profileConflict: () => false,
    execVersion: () => 'browser-rs 0.1.13',
    hashFile: () => goodSha,
  };

  test('reports unsupported platform before binary checks', () => {
    const result = preflightBrowserRsBinary({
      env: { BROWSER_RS_BIN: '/tmp/browser-rs' },
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.status).toBe('unsupported_platform');
    expect(result.platformKey).toBe('win32-x64');
  });

  test('reports missing binary when BROWSER_RS_BIN is absent', () => {
    const result = preflightBrowserRsBinary({ env: {}, platform: 'linux', arch: 'x64' });
    expect(result.status).toBe('missing_binary');
    expect(result.message).toContain('BROWSER_RS_BIN');
  });

  test('fails closed on version mismatch', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      execVersion: () => 'browser-rs 0.1.12',
      hashFile: () => goodSha,
    });
    expect(result.status).toBe('version_mismatch');
    expect(result.actualVersion).toBe('0.1.12');
  });

  test('fails closed on SHA mismatch', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      execVersion: () => 'browser-rs 0.1.13',
      hashFile: () => '0'.repeat(64),
    });
    expect(result.status).toBe('sha_mismatch');
    expect(result.expectedSha256).toBe(goodSha);
  });

  test('accepts the pinned version and platform digest', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      execVersion: () => 'browser-rs 0.1.13',
      hashFile: () => goodSha,
    });
    expect(result.status).toBe('ok');
    expect(result.asset).toBe('browser-rs-linux-x64');
    expect(result.actualSha256).toBe(goodSha);
    expect(result.binaryPath).toBe('/canonical/browser-rs');
    expect(result.command).toEqual(['/canonical/browser-rs']);
    expect(result.chromePath).toBe('/canonical/google-chrome');
  });

  test('uses the same canonical binary path for version, digest, and execution metadata', () => {
    const observed: string[] = [];
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: 'browser-rs',
      resolveBinary: () => '/opt/browser-rs/bin/browser-rs',
      execVersion: (binaryPath) => {
        observed.push(`version:${binaryPath}`);
        return 'browser-rs 0.1.13';
      },
      hashFile: (binaryPath) => {
        observed.push(`hash:${binaryPath}`);
        return goodSha;
      },
    });
    expect(result.status).toBe('ok');
    expect(result.command).toEqual(['/opt/browser-rs/bin/browser-rs']);
    expect(observed).toEqual([
      'version:/opt/browser-rs/bin/browser-rs',
      'hash:/opt/browser-rs/bin/browser-rs',
    ]);
  });

  test('reports missing Chrome before starting browser-rs', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      resolveChrome: () => null,
    });
    expect(result.status).toBe('chrome_missing');
    expect(result.message).toContain('AB_CHROME');
  });

  test('does not hide a pin mismatch behind a missing Chrome runtime', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      execVersion: () => 'browser-rs 0.1.12',
      hashFile: () => '0'.repeat(64),
      resolveChrome: () => null,
    });
    expect(result.status).toBe('version_mismatch');
    expect(result.actualVersion).toBe('0.1.12');
  });

  test('fails closed when the browser-rs profile has Chrome lock artifacts', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      env: { HOME: '/tmp/home' },
      profileConflict: () => true,
    });
    expect(result.status).toBe('profile_conflict');
    expect(result.profilePath).toBe(path.join('/tmp/home', '.browser-rs', 'profile'));
  });

  test('rejects HTTP mode because the benchmark adapter requires MCP stdio', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      args: ['--port', '9321'],
    });
    expect(result.status).toBe('port_conflict');
    expect(result.message).toContain('stdio');
  });

  test('rejects an unavailable configured CDP connect port', () => {
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      args: ['--connect', '9222'],
      connectProbe: () => false,
    });
    expect(result.status).toBe('port_conflict');
    expect(result.connectPort).toBe(9222);
  });

  test('uses a configured CDP URL without requiring local Chrome or a profile', () => {
    const resolveChrome = jest.fn(() => null);
    const profileConflict = jest.fn(() => true);
    const connectProbe = jest.fn(() => true);
    const result = preflightBrowserRsBinary({
      ...runnableDefaults,
      binaryPath: '/tmp/browser-rs',
      args: ['--connect', 'http://127.0.0.1:9222'],
      resolveChrome,
      profileConflict,
      connectProbe,
    });
    expect(result.status).toBe('ok');
    expect(result.connectPort).toBe(9222);
    expect(result.command).toEqual(['/canonical/browser-rs', '--connect', 'http://127.0.0.1:9222']);
    expect(result.chromePath).toBe('');
    expect(result.profilePath).toBe('');
    expect(connectProbe).toHaveBeenCalledWith(9222);
    expect(resolveChrome).not.toHaveBeenCalled();
    expect(profileConflict).not.toHaveBeenCalled();
  });
});
