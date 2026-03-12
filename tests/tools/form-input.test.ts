/// <reference types="jest" />
/**
 * Tests for Form Input Tool
 *
 * Updated for CDP native input approach (React/framework compat).
 * Call sequence for text inputs:
 *   1. DOM.resolveNode
 *   2. Runtime.callFunctionOn (element info)
 *   3. DOM.focus -> Input.dispatchKeyEvent (select-all) -> Input.insertText
 *   Fallback: Runtime.callFunctionOn with InputEvent
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

  /** Helper: mock the CDP sequence for a text input with CDP native path */
  function mockTextInputCDPSequence(opts: { value?: string } = {}) {
    mockSessionManager.mockCDPClient.send
      // 1. DOM.resolveNode
      .mockResolvedValueOnce({ object: { objectId: 'obj-1' } })
      // 2. Runtime.callFunctionOn (element info)
      .mockResolvedValueOnce({
        result: {
          value: {
            tagName: 'input', type: 'text',
            disabled: false, readOnly: false, contentEditable: false,
          },
        },
      })
      // 3. DOM.focus
      .mockResolvedValueOnce({})
      // 4. Input.dispatchKeyEvent (keyDown select-all)
      .mockResolvedValueOnce({})
      // 5. Input.dispatchKeyEvent (keyUp)
      .mockResolvedValueOnce({})
      // 6. Input.insertText
      .mockResolvedValueOnce({});
  }

  /** Helper: mock the CDP sequence for a textarea with CDP native path */
  function mockTextareaCDPSequence() {
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
      .mockResolvedValueOnce({
        result: {
          value: {
            tagName: 'textarea', type: '',
            disabled: false, readOnly: false, contentEditable: false,
          },
        },
      }) // element info
      .mockResolvedValueOnce({}) // DOM.focus
      .mockResolvedValueOnce({}) // keyDown
      .mockResolvedValueOnce({}) // keyUp
      .mockResolvedValueOnce({}); // insertText
  }

  /** Helper: mock CDP sequence for text input with CDP focus failure (fallback path) */
  function mockTextInputFallbackSequence() {
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
      .mockResolvedValueOnce({
        result: {
          value: {
            tagName: 'input', type: 'text',
            disabled: false, readOnly: false, contentEditable: false,
          },
        },
      }) // element info
      .mockRejectedValueOnce(new Error('Cannot focus element')) // DOM.focus fails
      .mockResolvedValueOnce({
        result: { value: { success: true, message: 'Set value to "fallback-val"' } },
      }); // Runtime.callFunctionOn fallback
  }

  /** Helper: mock CDP sequence for checkbox */
  function mockCheckboxCDPSequence(message: string) {
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
      .mockResolvedValueOnce({
        result: {
          value: {
            tagName: 'input', type: 'checkbox',
            disabled: false, readOnly: false, contentEditable: false,
          },
        },
      }) // element info
      .mockResolvedValueOnce({
        result: { value: { success: true, message } },
      }); // Runtime.callFunctionOn
  }

  /** Helper: mock CDP sequence for select */
  function mockSelectCDPSequence(message: string, success = true, error?: string) {
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
      .mockResolvedValueOnce({
        result: {
          value: {
            tagName: 'select', type: 'select-one',
            disabled: false, readOnly: false, contentEditable: false,
          },
        },
      }) // element info
      .mockResolvedValueOnce({
        result: { value: { success, message: success ? message : undefined, error: error } },
      }); // Runtime.callFunctionOn
  }

  /** Helper: mock CDP sequence for contenteditable */
  function mockContentEditableCDPSequence(message: string) {
    mockSessionManager.mockCDPClient.send
      .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
      .mockResolvedValueOnce({
        result: {
          value: {
            tagName: 'div', type: '',
            disabled: false, readOnly: false, contentEditable: true,
          },
        },
      }) // element info
      .mockResolvedValueOnce({
        result: { value: { success: true, message } },
      }); // Runtime.callFunctionOn
  }

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

  describe('Text Inputs (CDP native path)', () => {
    test('sets value in text input via CDP Input.insertText', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12345, 'textbox', 'Email');

      mockTextInputCDPSequence();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test@example.com',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('test@example.com');

      // Verify CDP calls: DOM.focus, Input.dispatchKeyEvent, Input.insertText
      const calls = mockSessionManager.mockCDPClient.send.mock.calls;
      const methods = calls.map((c: unknown[]) => c[1]);
      expect(methods).toContain('DOM.focus');
      expect(methods).toContain('Input.insertText');
    });

    test('sets value in textarea via CDP native path', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12346, 'textbox', 'Description');

      mockTextareaCDPSequence();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'Long text content',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Long text content');
    });

    test('CDP path attempts DOM.focus first for text inputs', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12347, 'textbox', 'Name');

      mockTextInputCDPSequence();

      await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'Test Name',
      });

      // DOM.focus should be called with the backendNodeId
      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(
        expect.anything(),
        'DOM.focus',
        expect.objectContaining({ backendNodeId: expect.any(Number) })
      );
    });

    test('falls back to InputEvent when CDP focus fails', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12348, 'textbox', 'Unfocusable');

      mockTextInputFallbackSequence();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'fallback-val',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('fallback-val');

      // Verify fallback Runtime.callFunctionOn was called (the last call)
      const calls = mockSessionManager.mockCDPClient.send.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toBe('Runtime.callFunctionOn');
      // The fallback function should contain 'InputEvent'
      expect(lastCall[2].functionDeclaration).toContain('InputEvent');
    });
  });

  describe('Checkboxes/Radios', () => {
    test('checks checkbox with true', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12349, 'checkbox', 'Remember me');

      mockCheckboxCDPSequence('Set to true');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: true,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('true');
    });

    test('unchecks checkbox with false', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12350, 'checkbox', 'Subscribe');

      mockCheckboxCDPSequence('Set to false');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: false,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('false');
    });

    test('handles string "true"', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12351, 'checkbox', 'Agree');

      mockCheckboxCDPSequence('Set to true');

      await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'true',
      });

      // The checkbox Runtime.callFunctionOn should receive the string 'true'
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
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12352, 'checkbox', 'Opt out');

      mockCheckboxCDPSequence('Set to false');

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
    test('selects option by value using native setter', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12353, 'combobox', 'Country');

      mockSelectCDPSequence('Selected "United States"');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'US',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Selected');

      // Verify the Runtime.callFunctionOn function uses native setter
      const calls = mockSessionManager.mockCDPClient.send.mock.calls;
      const runtimeCall = calls.find(
        (c: unknown[]) => {
          const params = c[2] as Record<string, unknown> | undefined;
          return c[1] === 'Runtime.callFunctionOn' &&
            typeof params?.functionDeclaration === 'string' &&
            (params.functionDeclaration as string).includes('HTMLSelectElement');
        }
      );
      expect(runtimeCall).toBeTruthy();
    });

    test('selects option by text', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12354, 'combobox', 'Language');

      mockSelectCDPSequence('Selected "English"');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'English',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('English');
    });

    test('returns error for nonexistent option', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12355, 'combobox', 'Size');

      mockSelectCDPSequence('', false, 'Option not found: XXL');

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
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12356, 'textbox', 'Rich Editor');

      mockContentEditableCDPSequence('Set content to "Rich text"');

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'Rich text',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Rich text');
    });
  });

  describe('Disabled/ReadOnly Guards', () => {
    test('returns error for disabled input', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12357, 'textbox', 'Disabled Field');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
        .mockResolvedValueOnce({
          result: {
            value: {
              tagName: 'input', type: 'text',
              disabled: true, readOnly: false, contentEditable: false,
            },
          },
        }); // element info

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disabled');
    });

    test('returns error for readOnly input', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12358, 'textbox', 'ReadOnly Field');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
        .mockResolvedValueOnce({
          result: {
            value: {
              tagName: 'input', type: 'text',
              disabled: false, readOnly: true, contentEditable: false,
            },
          },
        }); // element info

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('readOnly');
    });

    test('returns error for disabled select', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12359, 'combobox', 'Disabled Select');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
        .mockResolvedValueOnce({
          result: {
            value: {
              tagName: 'select', type: 'select-one',
              disabled: true, readOnly: false, contentEditable: false,
            },
          },
        }); // element info

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'US',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disabled');
    });

    test('returns error for readOnly textarea', async () => {
      const handler = await getFormInputHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12360, 'textbox', 'ReadOnly TextArea');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
        .mockResolvedValueOnce({
          result: {
            value: {
              tagName: 'textarea', type: '',
              disabled: false, readOnly: true, contentEditable: false,
            },
          },
        }); // element info

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        value: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('readOnly');
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
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12361, 'textbox', 'Stale');

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
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 12362, 'generic', 'Div');

      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({ object: { objectId: 'obj-1' } }) // DOM.resolveNode
        .mockResolvedValueOnce({
          result: {
            value: {
              tagName: 'div', type: '',
              disabled: false, readOnly: false, contentEditable: false,
            },
          },
        }); // element info — not editable

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
