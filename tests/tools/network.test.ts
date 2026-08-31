/// <reference types="jest" />
/**
 * Tests for Network Simulation Tool
 */

// Mock session manager before importing the module
const mockGetPage = jest.fn();
const mockSessionManager = {
  getPage: mockGetPage,
};

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => mockSessionManager),
}));

// Mock MCPServer
const mockRegisterTool = jest.fn();
const mockServer = {
  registerTool: mockRegisterTool,
};

// Import after mocking
import { registerNetworkTool } from '../../src/tools/network';

describe('Network Tool', () => {
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;
  let mockCdpSession: { send: jest.Mock; detach: jest.Mock };
  let mockPage: { createCDPSession: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockCdpSession = {
      send: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn().mockResolvedValue(undefined),
    };

    mockPage = {
      createCDPSession: jest.fn().mockResolvedValue(mockCdpSession),
    };

    mockGetPage.mockResolvedValue(mockPage);

    // Register tool to capture handler
    registerNetworkTool(mockServer as any);
    handler = mockRegisterTool.mock.calls[0][1];
  });

  describe('registration', () => {
    test('should register with correct name', () => {
      expect(mockRegisterTool).toHaveBeenCalledWith(
        'network',
        expect.any(Function),
        expect.objectContaining({ name: 'network' })
      );
    });

    test('should have correct input schema', () => {
      const definition = mockRegisterTool.mock.calls[0][2];
      expect(definition.inputSchema.required).toContain('tabId');
      expect(definition.inputSchema.required).toContain('preset');
    });
  });

  describe('validation', () => {
    test('should return error when tabId is missing', async () => {
      const result = await handler('session-1', { preset: '3g' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('should return error when preset is missing', async () => {
      const result = await handler('session-1', { tabId: 'tab-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('preset is required');
    });

    test('should return error when tab not found', async () => {
      mockGetPage.mockResolvedValue(null);

      const result = await handler('session-1', { tabId: 'nonexistent', preset: '3g' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('preset: offline', () => {
    test('should set offline mode', async () => {
      const result = await handler('session-1', { tabId: 'tab-1', preset: 'offline' });

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.emulateNetworkConditions', {
        offline: true,
        downloadThroughput: 0,
        uploadThroughput: 0,
        latency: 0,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.action).toBe('network_throttle');
      expect(response.preset).toBe('offline');
    });
  });

  describe('preset: 3g', () => {
    test('should apply 3G throttling', async () => {
      const result = await handler('session-1', { tabId: 'tab-1', preset: '3g' });

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: (1.5 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
        latency: 100,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.action).toBe('network_throttle');
      expect(response.preset).toBe('3g');
      expect(response.latencyMs).toBe(100);
    });
  });

  describe('preset: 4g', () => {
    test('should apply 4G throttling', async () => {
      const result = await handler('session-1', { tabId: 'tab-1', preset: '4g' });

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: (20 * 1024 * 1024) / 8,
        uploadThroughput: (10 * 1024 * 1024) / 8,
        latency: 20,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.preset).toBe('4g');
      expect(response.latencyMs).toBe(20);
    });
  });

  describe('preset: slow-2g', () => {
    test('should apply slow 2G throttling', async () => {
      const result = await handler('session-1', { tabId: 'tab-1', preset: 'slow-2g' });

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: (50 * 1024) / 8,
        uploadThroughput: (20 * 1024) / 8,
        latency: 2000,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.preset).toBe('slow-2g');
      expect(response.latencyMs).toBe(2000);
    });
  });

  describe('preset: clear', () => {
    test('should clear network throttling', async () => {
      const result = await handler('session-1', { tabId: 'tab-1', preset: 'clear' });

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: -1,
        uploadThroughput: -1,
        latency: 0,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.action).toBe('network_clear');
    });
  });

  describe('preset: custom', () => {
    test('should apply custom throttling', async () => {
      const result = await handler('session-1', {
        tabId: 'tab-1',
        preset: 'custom',
        downloadKbps: 1000,
        uploadKbps: 500,
        latencyMs: 50,
      });

      expect(mockCdpSession.send).toHaveBeenCalledWith('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: (1000 * 1024) / 8,
        uploadThroughput: (500 * 1024) / 8,
        latency: 50,
      });

      const response = JSON.parse(result.content[0].text);
      expect(response.action).toBe('network_custom');
      expect(response.downloadKbps).toBe(1000);
      expect(response.uploadKbps).toBe(500);
      expect(response.latencyMs).toBe(50);
    });

    test('should return error when custom params are missing', async () => {
      const result = await handler('session-1', {
        tabId: 'tab-1',
        preset: 'custom',
        downloadKbps: 1000,
        // missing uploadKbps and latencyMs
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('downloadKbps, uploadKbps, and latencyMs');
    });
  });

  describe('unknown preset', () => {
    test('should return error for unknown preset', async () => {
      const result = await handler('session-1', { tabId: 'tab-1', preset: 'unknown-preset' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown preset');
    });
  });

  describe('CDP session management', () => {
    test('should detach CDP session after operation', async () => {
      await handler('session-1', { tabId: 'tab-1', preset: '3g' });

      expect(mockCdpSession.detach).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    test('should handle CDP errors gracefully', async () => {
      mockCdpSession.send.mockRejectedValue(new Error('CDP protocol error'));

      const result = await handler('session-1', { tabId: 'tab-1', preset: '3g' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
      expect(result.content[0].text).toContain('CDP protocol error');
    });
  });
});
