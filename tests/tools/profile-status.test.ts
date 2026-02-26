/// <reference types="jest" />
/**
 * Tests for oc_profile_status tool
 */

import { createMockSessionManager } from '../utils/mock-session';

const mockGetProfileState = jest.fn();

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn(() => ({
    ensureChrome: jest.fn().mockResolvedValue({
      wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      httpEndpoint: 'http://127.0.0.1:9222',
    }),
    isConnected: jest.fn().mockReturnValue(true),
    close: jest.fn().mockResolvedValue(undefined),
    getPort: jest.fn().mockReturnValue(9222),
    getProfileState: mockGetProfileState,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { MCPServer } from '../../src/mcp-server';
import { registerProfileStatusTool } from '../../src/tools/profile-status';

describe('oc_profile_status tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    const mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    server = new MCPServer(mockSessionManager as any);
    registerProfileStatusTool(server);
    handler = server.getToolHandler('oc_profile_status')!;
    expect(handler).toBeDefined();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('reports real profile correctly', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'real',
      extensionsAvailable: true,
      userDataDir: '/Users/test/Library/Application Support/Google/Chrome',
    });
    const result = await handler('default', {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    const data = JSON.parse(result.content[0].text);
    expect(data.profileType).toBe('real');
    expect(data.capabilities.extensions).toBe(true);
    expect(data.capabilities.savedPasswords).toBe(true);
    expect(data.capabilities.localStorage).toBe(true);
    expect(result.content[1].text).toContain('Real Chrome profile');
  });

  test('reports temp-snapshot profile with cookie age', async () => {
    const fiveMinAgo = Date.now() - 300000;
    mockGetProfileState.mockReturnValue({
      type: 'temp-snapshot',
      cookieCopiedAt: fiveMinAgo,
      extensionsAvailable: false,
      sourceProfile: '/Users/test/Library/Application Support/Google/Chrome',
      userDataDir: '/tmp/openchrome-123',
    });
    const result = await handler('default', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.profileType).toBe('temp-snapshot');
    expect(data.capabilities.extensions).toBe(false);
    expect(data.capabilities.sessionCookies).toBe(true);
    expect(data.cookiesCopied).toBe(true);
    expect(data.realProfilePath).toBe('/Users/test/Library/Application Support/Google/Chrome');
    expect(data.realProfileLocked).toBe(true);
    expect(result.content[1].text).toContain('Temporary profile');
  });

  test('reports temp-fresh profile', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'temp-fresh',
      extensionsAvailable: false,
      userDataDir: '/tmp/openchrome-456',
    });
    const result = await handler('default', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.profileType).toBe('temp-fresh');
    expect(data.capabilities.extensions).toBe(false);
    expect(data.capabilities.sessionCookies).toBe(false);
    expect(result.content[1].text).toContain('Fresh temporary profile');
    expect(result.content[1].text).toContain('log in manually');
  });

  test('handles launcher not initialized gracefully', async () => {
    mockGetProfileState.mockImplementation(() => {
      throw new Error('Chrome not launched');
    });
    const result = await handler('default', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error checking profile status');
  });

  test('tool is registered with correct name', () => {
    expect(server.getToolNames()).toContain('oc_profile_status');
  });

  test('cookie age is a number in milliseconds', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'temp-snapshot',
      cookieCopiedAt: Date.now() - 60000,
      extensionsAvailable: false,
      sourceProfile: '/Users/test/Chrome',
      userDataDir: '/tmp/openchrome-999',
    });
    const result = await handler('default', {});
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.cookieAge).toBe('number');
    expect(data.cookieAge).toBeGreaterThanOrEqual(60000);
    expect(data.cookieAgeFormatted).toMatch(/\d+[smh] ago/);
  });
});
