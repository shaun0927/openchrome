/// <reference types="jest" />
/**
 * Tests for oc_connection_health tool
 */

import { createMockSessionManager } from '../utils/mock-session';

const mockGetConnectionMetrics = jest.fn();
const mockGetConnectionState = jest.fn();

jest.mock('../../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    getConnectionMetrics: mockGetConnectionMetrics,
    getConnectionState: mockGetConnectionState,
  })),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { MCPServer } from '../../src/mcp-server';
import { registerConnectionHealthTool } from '../../src/tools/connection-health';

describe('oc_connection_health tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

  const baseMetrics = {
    heartbeatMode: 'active',
    reconnectCount: 2,
    avgPingLatencyMs: 42,
    msSinceLastVerified: 1500,
    consecutiveSuccesses: 5,
    lastVerifiedAt: Date.now() - 1500,
  };

  beforeEach(() => {
    const mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    server = new MCPServer(mockSessionManager as any);
    registerConnectionHealthTool(server);
    handler = server.getToolHandler('oc_connection_health')!;
    expect(handler).toBeDefined();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('tool is registered with correct name', () => {
    expect(server.getToolNames()).toContain('oc_connection_health');
  });

  test('returns all expected fields in connected state', async () => {
    mockGetConnectionState.mockReturnValue('connected');
    mockGetConnectionMetrics.mockReturnValue(baseMetrics);

    const result = await handler('default', {});

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);

    const data = JSON.parse(result.content[0].text);
    expect(data.connectionState).toBe('connected');
    expect(data.heartbeatMode).toBe('active');
    expect(data.reconnectCount).toBe(2);
    expect(data.avgPingLatencyMs).toBe(42);
    expect(data.msSinceLastVerified).toBe(1500);
    expect(data.consecutiveSuccesses).toBe(5);
    expect(data.lastVerifiedAt).not.toBeNull();
    // Should be an ISO string
    expect(typeof data.lastVerifiedAt).toBe('string');
    expect(() => new Date(data.lastVerifiedAt)).not.toThrow();
  });

  test('returns null for lastVerifiedAt when lastVerifiedAt is 0', async () => {
    mockGetConnectionState.mockReturnValue('disconnected');
    mockGetConnectionMetrics.mockReturnValue({
      ...baseMetrics,
      lastVerifiedAt: 0,
      msSinceLastVerified: 0,
    });

    const result = await handler('default', {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.lastVerifiedAt).toBeNull();
    expect(data.connectionState).toBe('disconnected');
  });

  test('reports reconnecting state correctly', async () => {
    mockGetConnectionState.mockReturnValue('reconnecting');
    mockGetConnectionMetrics.mockReturnValue({
      ...baseMetrics,
      reconnectCount: 3,
      consecutiveSuccesses: 0,
    });

    const result = await handler('default', {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.connectionState).toBe('reconnecting');
    expect(data.reconnectCount).toBe(3);
    expect(data.consecutiveSuccesses).toBe(0);
  });

  test('returns isError when getCDPClient throws', async () => {
    const { getCDPClient } = require('../../src/cdp/client');
    (getCDPClient as jest.Mock).mockImplementationOnce(() => {
      throw new Error('CDP client not initialized');
    });

    const result = await handler('default', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection health unavailable');
    expect(result.content[0].text).toContain('CDP client not initialized');
  });

  test('returns isError when getConnectionMetrics throws', async () => {
    mockGetConnectionState.mockReturnValue('connected');
    mockGetConnectionMetrics.mockImplementation(() => {
      throw new Error('Metrics not available');
    });

    const result = await handler('default', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection health unavailable');
    expect(result.content[0].text).toContain('Metrics not available');
  });

  test('output is valid JSON', async () => {
    mockGetConnectionState.mockReturnValue('connected');
    mockGetConnectionMetrics.mockReturnValue(baseMetrics);

    const result = await handler('default', {});

    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});
