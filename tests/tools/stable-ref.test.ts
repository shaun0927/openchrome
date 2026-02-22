/// <reference types="jest" />
/**
 * Integration tests for stable ref formats (ref_N, raw integer, node_N)
 * across computer (scroll_to) and form_input tools.
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));
jest.mock('../../src/utils/ref-id-manager', () => ({ getRefIdManager: jest.fn() }));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('Stable Ref Formats', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getComputerHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));
    const { registerComputerTool } = await import('../../src/tools/computer');
    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };
    registerComputerTool(mockServer as unknown as Parameters<typeof registerComputerTool>[0]);
    return tools.get('computer')!.handler;
  };

  const getFormInputHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));
    const { registerFormInputTool } = await import('../../src/tools/form-input');
    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };
    registerFormInputTool(mockServer as unknown as Parameters<typeof registerFormInputTool>[0]);
    return tools.get('form_input')!.handler;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-stable';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // computer scroll_to tests
  // ---------------------------------------------------------------------------
  describe('computer scroll_to', () => {
    test('works with ref_N (backward compat)', async () => {
      const handler = await getComputerHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'button', 'Submit');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
        ref: refId,
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Scrolled to');
      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, refId);
    });

    test('works with raw integer backendNodeId "142"', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
        ref: '142',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Scrolled to');
      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, '142');
    });

    test('works with node_ prefix "node_142"', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
        ref: 'node_142',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Scrolled to');
      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, 'node_142');
    });

    test('returns error with updated message for invalid ref', async () => {
      const handler = await getComputerHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        action: 'scroll_to',
        ref: 'totally_invalid',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('totally_invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // form_input tests
  // ---------------------------------------------------------------------------
  describe('form_input', () => {
    test('works with ref_N (backward compat)', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'textbox', 'Email');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set value to "hello"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'hello',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('hello');
      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, refId);
    });

    test('works with raw integer backendNodeId "200"', async () => {
      const handler = await getFormInputHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-2' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set value to "world"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: '200',
        value: 'world',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('world');
      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, '200');
    });

    test('works with node_ prefix "node_200"', async () => {
      const handler = await getFormInputHandler();

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-3' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set value to "test"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: 'node_200',
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('test');
      expect(mockRefIdManager.resolveToBackendNodeId).toHaveBeenCalledWith(testSessionId, testTargetId, 'node_200');
    });

    test('returns error with updated message for invalid ref', async () => {
      const handler = await getFormInputHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: 'totally_invalid',
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('totally_invalid');
    });
  });
});
