/// <reference types="jest" />
/**
 * Tests for devtools field on oc_get_connection_info (#860)
 */

import { createMockSessionManager } from '../utils/mock-session';

// Mock getChromePool
const mockGetInstances = jest.fn();
jest.mock('../../src/chrome/pool', () => ({
  getChromePool: jest.fn(() => ({ getInstances: mockGetInstances })),
  resetChromePool: jest.fn(),
}));

// Mock devtools-info helpers
const mockGetDevToolsInstanceInfo = jest.fn();
jest.mock('../../src/chrome/devtools-info', () => ({
  getDevToolsInstanceInfo: mockGetDevToolsInstanceInfo,
  fetchJsonList: jest.fn(),
}));

// Mock getGlobalConfig
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn(() => ({ port: 9222 })),
}));

// Mock session manager
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Mock connect helpers (generateConnectionInfo etc.)
jest.mock('../../src/connect/index', () => ({
  generateConnectionInfo: jest.fn(() => ({
    hostName: 'Claude Web',
    mcpUrl: 'http://127.0.0.1:3100/mcp',
    bearerToken: null,
    settingsUrl: 'https://claude.ai/settings/integrations',
    instructions: [],
  })),
  generateAllConnectionInfo: jest.fn(() => ({})),
  getHostIds: jest.fn(() => ['claude', 'chatgpt', 'gemini', 'custom']),
}));

jest.mock('../../src/connect/clipboard', () => ({ copyToClipboard: jest.fn() }));
jest.mock('../../src/connect/open-url', () => ({ openInBrowser: jest.fn() }));

import { getSessionManager } from '../../src/session-manager';
import { MCPServer } from '../../src/mcp-server';
import { registerConnectTools } from '../../src/tools/connect';

const FIXTURE_INSTANCE = {
  instancePort: 9222,
  browserInspectorUrl: 'http://127.0.0.1:9222/devtools/browser/abc123',
  pages: [
    {
      targetId: 'target-abc',
      instancePort: 9222,
      url: 'https://example.com',
      title: 'Example Domain',
      devtoolsFrontendUrl:
        'http://127.0.0.1:9222/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/target-abc',
    },
  ],
};

describe('oc_get_connection_info devtools field (#860)', () => {
  let server: MCPServer;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetInstances.mockReturnValue(new Map()); // empty pool → default port
    mockGetDevToolsInstanceInfo.mockResolvedValue(FIXTURE_INSTANCE);

    delete process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL;

    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);

    server = new MCPServer(mockSessionManager as any);
    registerConnectTools(server);
    handler = server.getToolHandler('oc_get_connection_info')!;
  });

  afterEach(() => {
    delete process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL;
    delete process.env.OPENCHROME_PROFILE;
  });



  test('host=openchrome reports fast runtime profile when enabled', async () => {
    process.env.OPENCHROME_PROFILE = 'fast';

    const result = await handler('default', { host: 'openchrome' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.mode).toBe('managed');
    expect(data.runtimeProfile).toMatchObject({ profile: 'fast', source: 'env', fast: true });
    expect(data.runtimeProfile.guidance.join(' ')).toContain('read_page AX defaults to compact');
  });


  test('host=openchrome managed response includes devtools block when Chrome is reachable', async () => {
    const result = await handler('default', { host: 'openchrome' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe('managed');
    expect(data.devtools).toBeDefined();
    expect(data.devtools.instances[0].pages[0].devtoolsFrontendUrl).toBe(
      FIXTURE_INSTANCE.pages[0].devtoolsFrontendUrl
    );
  });

  test('host=openchrome omits devtools block when exposure is disabled', async () => {
    process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL = '0';

    const result = await handler('default', { host: 'openchrome' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.mode).toBe('managed');
    expect(data.devtools).toBeUndefined();
  });

  test('tool is registered', () => {
    expect(server.getToolNames()).toContain('oc_get_connection_info');
  });

  test('response includes devtools block when Chrome is reachable', async () => {
    const result = await handler('default', { host: 'claude' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.devtools).toBeDefined();
    expect(data.devtools.instances).toHaveLength(1);
    expect(data.devtools.instances[0].instancePort).toBe(9222);
    expect(data.devtools.instances[0].browserInspectorUrl).toBe(
      'http://127.0.0.1:9222/devtools/browser/abc123'
    );
    expect(data.devtools.instances[0].pages[0].targetId).toBe('target-abc');
  });

  test('devtoolsFrontendUrl is character-for-character identical to fixture', async () => {
    const result = await handler('default', { host: 'claude' });
    const data = JSON.parse(result.content[0].text);
    expect(data.devtools.instances[0].pages[0].devtoolsFrontendUrl).toBe(
      FIXTURE_INSTANCE.pages[0].devtoolsFrontendUrl
    );
  });

  test('devtools field is omitted (not error) when Chrome is unreachable', async () => {
    mockGetDevToolsInstanceInfo.mockResolvedValue(null);

    const result = await handler('default', { host: 'claude' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.devtools).toBeUndefined();
    expect(data.hostName).toBeDefined();
  });

  test('devtools field is omitted when OPENCHROME_EXPOSE_DEVTOOLS_URL=0', async () => {
    process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL = '0';

    const result = await handler('default', { host: 'claude' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.devtools).toBeUndefined();
  });

  test('host=all response also includes devtools block', async () => {
    const result = await handler('default', { host: 'all' });
    const data = JSON.parse(result.content[0].text);
    expect(data.devtools).toBeDefined();
    expect(data.devtools.instances).toHaveLength(1);
  });

  test('multi-instance pool: one entry per reachable instance', async () => {
    const instance2 = {
      ...FIXTURE_INSTANCE,
      instancePort: 9223,
      browserInspectorUrl: 'http://127.0.0.1:9223/devtools/browser/def456',
    };
    mockGetInstances.mockReturnValue(
      new Map([
        [9222, { port: 9222 }],
        [9223, { port: 9223 }],
      ])
    );
    mockGetDevToolsInstanceInfo
      .mockResolvedValueOnce(FIXTURE_INSTANCE)
      .mockResolvedValueOnce(instance2);

    const result = await handler('default', { host: 'claude' });
    const data = JSON.parse(result.content[0].text);
    expect(data.devtools.instances).toHaveLength(2);
    expect(data.devtools.instances[0].instancePort).toBe(9222);
    expect(data.devtools.instances[1].instancePort).toBe(9223);
  });

  test('returns isError for invalid host', async () => {
    const result = await handler('default', { host: 'invalid-host' });
    expect(result.isError).toBe(true);
  });

  test('output is valid JSON', async () => {
    const result = await handler('default', { host: 'claude' });
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});
