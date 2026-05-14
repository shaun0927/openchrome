/// <reference types="jest" />
/**
 * Tests for oc_devtools_url tool (#860)
 */

import { createMockSessionManager } from '../utils/mock-session';

// Mock getChromePool
const mockGetInstances = jest.fn();
jest.mock('../../src/chrome/pool', () => ({
  getChromePool: jest.fn(() => ({ getInstances: mockGetInstances })),
}));

// Mock fetchJsonList
const mockFetchJsonList = jest.fn();
jest.mock('../../src/chrome/devtools-info', () => ({
  fetchJsonList: mockFetchJsonList,
}));

// Mock getGlobalConfig
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn(() => ({ port: 9222 })),
}));

// Mock session manager
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { MCPServer } from '../../src/mcp-server';
import { registerOcDevToolsUrlTool } from '../../src/tools/oc-devtools-url';

const FIXTURE_PAGES = [
  {
    id: 'target-abc',
    url: 'https://example.com',
    title: 'Example Domain',
    devtoolsFrontendUrl: 'http://127.0.0.1:9222/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/target-abc',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-abc',
    type: 'page',
  },
  {
    id: 'target-wiki',
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    title: 'Wikipedia',
    devtoolsFrontendUrl: 'http://127.0.0.1:9222/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/target-wiki',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-wiki',
    type: 'page',
  },
];

function makeServer(sessionManager: any): { server: MCPServer; handler: Function } {
  const server = new MCPServer(sessionManager as any);
  registerOcDevToolsUrlTool(server);
  const handler = server.getToolHandler('oc_devtools_url')!;
  return { server, handler };
}

describe('oc_devtools_url tool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL;

    mockGetInstances.mockReturnValue(new Map()); // empty pool → fall back to default port
    mockFetchJsonList.mockResolvedValue(FIXTURE_PAGES);

    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
  });

  afterEach(() => {
    delete process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL;
  });

  // --- registration ---

  test('tool is registered when enabled (default)', () => {
    const { server } = makeServer(mockSessionManager);
    expect(server.getToolNames()).toContain('oc_devtools_url');
  });

  test('tool is NOT registered when OPENCHROME_EXPOSE_DEVTOOLS_URL=0', () => {
    process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL = '0';
    const { server } = makeServer(mockSessionManager);
    expect(server.getToolNames()).not.toContain('oc_devtools_url');
  });

  // --- off-switch: handler returns disabled when called directly ---

  test('handler returns {error: disabled} when env set to 0 after registration', async () => {
    // Register while enabled, then flip env — handler must honour runtime check
    const { handler } = makeServer(mockSessionManager);
    process.env.OPENCHROME_EXPOSE_DEVTOOLS_URL = '0';
    const result = await handler('default', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('disabled');
  });

  // --- explicit targetId ---

  test('returns url for explicit targetId found in /json/list', async () => {
    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', { targetId: 'target-abc' });
    const data = JSON.parse(result.content[0].text);
    expect(data.targetId).toBe('target-abc');
    expect(data.url).toBe(FIXTURE_PAGES[0].devtoolsFrontendUrl);
  });

  test('returns {error: not_found} for unknown targetId (Chrome reachable, target absent)', async () => {
    const { handler } = makeServer(mockSessionManager);
    mockFetchJsonList.mockResolvedValue([]); // Chrome responds but target not present
    const result = await handler('default', { targetId: 'does-not-exist' });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('not_found');
    expect(data.message).toBeDefined();
  });

  test('returns {error: chrome_unreachable} when /json/list returns null', async () => {
    const { handler } = makeServer(mockSessionManager);
    mockFetchJsonList.mockResolvedValue(null);
    const result = await handler('default', { targetId: 'target-abc' });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('chrome_unreachable');
  });

  // --- no URL rewriting ---

  test('devtoolsFrontendUrl is character-for-character identical to fixture value', async () => {
    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', { targetId: 'target-wiki' });
    const data = JSON.parse(result.content[0].text);
    expect(data.url).toBe(FIXTURE_PAGES[1].devtoolsFrontendUrl);
  });

  // --- worker-based resolution ---

  test('returns url for default worker current target when no args given', async () => {
    await mockSessionManager.createSession({ id: 'default' });
    const session = mockSessionManager.getSession('default')!;
    const worker = session.workers.get('default')!;
    worker.targets.add('target-abc');

    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.targetId).toBe('target-abc');
    expect(data.url).toBeDefined();
    expect(data.url).toContain('devtools');
  });

  test('returns url for explicit workerId current target', async () => {
    await mockSessionManager.createSession({ id: 'default' });
    await mockSessionManager.createWorker('default', { id: 'worker-2' });
    const session = mockSessionManager.getSession('default')!;
    session.workers.get('worker-2')!.targets.add('target-wiki');

    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', { workerId: 'worker-2' });
    const data = JSON.parse(result.content[0].text);
    expect(data.targetId).toBe('target-wiki');
    expect(data.url).toBe(FIXTURE_PAGES[1].devtoolsFrontendUrl);
  });

  test('returns {error: not_found} when worker has no targets', async () => {
    await mockSessionManager.createSession({ id: 'default' });
    // default worker has no targets

    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('not_found');
  });

  test('returns {error: not_found} for unknown workerId', async () => {
    await mockSessionManager.createSession({ id: 'default' });

    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', { workerId: 'nonexistent-worker' });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('not_found');
  });

  // --- multi-instance pool ---

  test('walks pool instances to find target port', async () => {
    mockGetInstances.mockReturnValue(
      new Map([
        [9222, { port: 9222 }],
        [9223, { port: 9223 }],
      ])
    );
    // 9222 returns empty, 9223 has the target; second call for getDevToolsFrontendUrl also from 9223
    mockFetchJsonList
      .mockResolvedValueOnce([])           // resolvePortForTarget → port 9222, no match
      .mockResolvedValueOnce(FIXTURE_PAGES) // resolvePortForTarget → port 9223, match
      .mockResolvedValueOnce(FIXTURE_PAGES); // getDevToolsFrontendUrl → port 9223

    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', { targetId: 'target-abc' });
    const data = JSON.parse(result.content[0].text);
    expect(data.targetId).toBe('target-abc');
    expect(data.url).toBeDefined();
  });

  // --- edge cases ---

  test('returns {error: chrome_unreachable} when /json/list returns malformed data (null)', async () => {
    const { handler } = makeServer(mockSessionManager);
    mockFetchJsonList.mockResolvedValue(null);
    const result = await handler('default', { targetId: 'target-abc' });
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('chrome_unreachable');
  });

  test('output is valid JSON', async () => {
    const { handler } = makeServer(mockSessionManager);
    const result = await handler('default', { targetId: 'target-abc' });
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});
