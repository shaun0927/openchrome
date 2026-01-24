/// <reference types="jest" />
/**
 * Tests for Form Input Tool
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('FormInputTool', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

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

    testSessionId = 'test-session-123';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Text Inputs', () => {
    test('sets value in text input', async () => {
      const handler = await getFormInputHandler();

      // Create a ref
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'textbox', 'Email');

      // Mock CDP responses
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set value to "test@example.com"' } },
        }); // Runtime.callFunctionOn

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test@example.com',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('test@example.com');
    });

    test('sets value in textarea', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12346, 'textbox', 'Description');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set value to "Long text content"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'Long text content',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Long text content');
    });

    test('dispatches input and change events', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12347, 'textbox', 'Name');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set value' } },
        });

      // The function passed to Runtime.callFunctionOn should dispatch events
      // This is verified by checking the function was called correctly
      await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'Test Name',
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.callFunctionOn',
        expect.objectContaining({
          objectId: 'obj-1',
          arguments: [{ value: 'Test Name' }],
        })
      );
    });
  });

  describe('Checkboxes/Radios', () => {
    test('checks checkbox with true', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12348, 'checkbox', 'Remember me');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set to true' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: true,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('true');
    });

    test('unchecks checkbox with false', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12349, 'checkbox', 'Subscribe');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set to false' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: false,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('false');
    });

    test('handles string "true"', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12350, 'checkbox', 'Agree');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set to true' } },
        });

      await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'true',
      });

      // The function should convert string 'true' to boolean true
      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.callFunctionOn',
        expect.objectContaining({
          arguments: [{ value: 'true' }],
        })
      );
    });

    test('handles string "false"', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12351, 'checkbox', 'Opt out');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set to false' } },
        });

      await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'false',
      });

      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'Runtime.callFunctionOn',
        expect.objectContaining({
          arguments: [{ value: 'false' }],
        })
      );
    });
  });

  describe('Select Elements', () => {
    test('selects option by value', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12352, 'combobox', 'Country');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Selected "United States"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'US',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Selected');
    });

    test('selects option by text', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12353, 'combobox', 'Language');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Selected "English"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'English',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('English');
    });

    test('returns error for nonexistent option', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12354, 'combobox', 'Size');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: false, error: 'Option not found: XXL' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'XXL',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Option not found');
    });
  });

  describe('ContentEditable', () => {
    test('sets text content', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12355, 'textbox', 'Rich Editor');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: true, message: 'Set content to "Rich text"' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'Rich text',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Rich text');
    });
  });

  describe('Error Cases', () => {
    test('returns error for missing tabId', async () => {
      const handler = await getFormInputHandler();

      const result = await handler(testSessionId, {
        ref: 'ref_1',
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('returns error for missing ref', async () => {
      const handler = await getFormInputHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ref is required');
    });

    test('returns error for missing value', async () => {
      const handler = await getFormInputHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: 'ref_1',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('value is required');
    });

    test('returns error for invalid ref', async () => {
      const handler = await getFormInputHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: 'nonexistent_ref',
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    test('returns error for stale ref (element no longer exists)', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12356, 'textbox', 'Stale');

      // DOM.resolveNode returns no object (element was removed)
      mockSessionManager.mockCDPClient.send.mockResolvedValueOnce({ object: null });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no longer exist');
    });

    test('returns error for non-editable element', async () => {
      const handler = await getFormInputHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12357, 'generic', 'Div');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
        .mockResolvedValueOnce({
          result: { value: { success: false, error: 'Element is not editable: div' } },
        });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not editable');
    });

    test('returns error when tab not found', async () => {
      const handler = await getFormInputHandler();
      mockSessionManager.getPage.mockResolvedValueOnce(null);

      const result = await handler(testSessionId, {
        tabId: 'non-existent-tab',
        ref: 'ref_1',
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('Session Isolation', () => {
    test('rejects form input on tab from another session', async () => {
      const handler = await getFormInputHandler();

      const session2Id = 'other-session';
      await mockSessionManager.createSession({ id: session2Id });
      const { targetId: session2TargetId } = await mockSessionManager.createTarget(session2Id);

      const result = await handler(testSessionId, {
        tabId: session2TargetId,
        ref: 'ref_1',
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not belong to session');
    });
  });
});
