/**
 * Form Input Tool - Set values in form elements
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { withDomDelta } from '../utils/dom-delta';

const definition: MCPToolDefinition = {
  name: 'form_input',
  description: 'Set form element value by ref.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to set form value in',
      },
      ref: {
        type: 'string',
        description: 'Element ref or backendNodeId',
      },
      value: {
        type: 'string',
        description: 'Value to set. Checkboxes: "true"/"false"',
      },
    },
    required: ['ref', 'value', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const ref = args.ref as string;
  const value = args.value;

  const sessionManager = getSessionManager();
  const refIdManager = getRefIdManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!ref) {
    return {
      content: [{ type: 'text', text: 'Error: ref is required' }],
      isError: true,
    };
  }

  if (value === undefined) {
    return {
      content: [{ type: 'text', text: 'Error: value is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'form_input');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Get the backend node ID
    let backendNodeId = refIdManager.resolveToBackendNodeId(sessionId, tabId, ref);
    if (backendNodeId === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Reference '${ref}' not found. Use read_page first to get element references (ref_N or backendNodeId).`,
          },
        ],
        isError: true,
      };
    }

    const cdpClient = sessionManager.getCDPClient();

    // Validate ref identity if fingerprint is available
    const refEntry = refIdManager.getRef(sessionId, tabId, ref);
    if (refEntry && refEntry.tagName) {
      try {
        const { node } = await cdpClient.send<{
          node: { localName: string };
        }>(page, 'DOM.describeNode', { backendNodeId });

        const validation = refIdManager.validateRef(
          sessionId, tabId, ref,
          node.localName
        );

        if (!validation.valid && validation.stale) {
          // Attempt transparent recovery: re-find the element using stored metadata
          const relocated = await refIdManager.tryRelocateRef(
            sessionId, tabId, ref, page, cdpClient
          );

          if (relocated) {
            console.error(`[ref-recovery] ${ref} was stale, re-located as ${relocated.newRef}`);
            backendNodeId = relocated.backendNodeId;
          } else {
            return {
              content: [{
                type: 'text',
                text: `Error: ${ref} is stale — ${validation.reason}. Element could not be re-located. Run find or read_page again to get fresh refs.`,
              }],
              isError: true,
            };
          }
        }
      } catch {
        // If validation fails, proceed — DOM.resolveNode will catch removed elements
      }
    }

    // Resolve the node
    const { object } = await cdpClient.send<{ object: { objectId: string } }>(
      page,
      'DOM.resolveNode',
      { backendNodeId }
    );

    if (!object?.objectId) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Could not resolve element ${ref}. The element may no longer exist.`,
          },
        ],
        isError: true,
      };
    }

    // Detect element type, check disabled/readOnly, and decide approach
    const { result: elementInfo } = await cdpClient.send<{
      result: { value: { tagName: string; type: string; disabled: boolean; readOnly: boolean; contentEditable: boolean } };
    }>(page, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `
        function() {
          const el = this;
          return {
            tagName: el.tagName.toLowerCase(),
            type: (el.type || '').toLowerCase(),
            disabled: !!el.disabled,
            readOnly: !!el.readOnly,
            contentEditable: el.contentEditable === 'true',
          };
        }
      `,
      returnByValue: true,
    });

    const elInfo = elementInfo.value;

    // Guard: disabled elements
    if (elInfo.disabled) {
      return {
        content: [{
          type: 'text',
          text: `Error: Element is disabled. Enable it first or use javascript_tool to remove the disabled attribute.`,
        }],
        isError: true,
      };
    }

    // Guard: readOnly elements (only for input/textarea)
    if (elInfo.readOnly && (elInfo.tagName === 'input' || elInfo.tagName === 'textarea')) {
      return {
        content: [{
          type: 'text',
          text: `Error: Element is readOnly. Use fill_form with keyboard input or javascript_tool to modify the value programmatically.`,
        }],
        isError: true,
      };
    }

    // Set the value based on element type with DOM delta capture
    const { result, delta } = await withDomDelta(page, async () => {
      if (elInfo.tagName === 'input' || elInfo.tagName === 'textarea') {
        if (elInfo.type === 'checkbox' || elInfo.type === 'radio') {
          // Checkboxes and radios: use injected function (no CDP keyboard needed)
          return cdpClient.send<{
            result: { value: { success: boolean; message?: string; error?: string } };
          }>(page, 'Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `
              function(newValue) {
                try {
                  const el = this;
                  const shouldCheck = typeof newValue === 'boolean' ? newValue : newValue === 'true' || newValue === true;
                  if (el.checked !== shouldCheck) {
                    el.checked = shouldCheck;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  return { success: true, message: 'Set to ' + shouldCheck };
                } catch (e) {
                  return { success: false, error: e.message };
                }
              }
            `,
            arguments: [{ value }],
            returnByValue: true,
          });
        }

        // Text inputs and textareas: try CDP native input first for React/framework compat
        let usedCDP = false;
        try {
          // Focus the element via CDP
          await cdpClient.send(page, 'DOM.focus', { backendNodeId });

          // Select all existing text (Ctrl+A / Cmd+A)
          const selectAllModifier = process.platform === 'darwin' ? 4 : 2; // 4=Meta, 2=Control
          await cdpClient.send(page, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            modifiers: selectAllModifier,
          });
          await cdpClient.send(page, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
          });

          // Insert the new value via CDP Input.insertText
          await cdpClient.send(page, 'Input.insertText', { text: String(value) });
          usedCDP = true;
        } catch {
          // CDP focus/input failed — element may not be focusable via CDP
          usedCDP = false;
        }

        if (usedCDP) {
          return {
            result: {
              value: { success: true, message: `Set value to "${value}"` },
            },
          } as { result: { value: { success: boolean; message?: string; error?: string } } };
        }

        // Fallback: programmatic setter with upgraded InputEvent for better framework compat
        return cdpClient.send<{
          result: { value: { success: boolean; message?: string; error?: string } };
        }>(page, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `
            function(newValue) {
              try {
                const el = this;
                el.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, 'value'
                )?.set || Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                )?.set;
                if (nativeSetter) {
                  nativeSetter.call(el, String(newValue));
                } else {
                  el.value = String(newValue);
                }
                el.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  composed: true,
                  inputType: 'insertText',
                  data: String(newValue),
                }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                return { success: true, message: 'Set value to "' + newValue + '"' };
              } catch (e) {
                return { success: false, error: e.message };
              }
            }
          `,
          arguments: [{ value }],
          returnByValue: true,
        });
      } else if (elInfo.tagName === 'select') {
        // Select elements: use native setter for React/framework compat
        return cdpClient.send<{
          result: { value: { success: boolean; message?: string; error?: string } };
        }>(page, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `
            function(newValue) {
              try {
                const el = this;
                const options = Array.from(el.options);
                const option = options.find(o =>
                  o.value === String(newValue) ||
                  o.textContent?.trim() === String(newValue)
                );
                if (option) {
                  const selectSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLSelectElement.prototype, 'value'
                  )?.set;
                  if (selectSetter) {
                    selectSetter.call(el, option.value);
                  } else {
                    el.value = option.value;
                  }
                  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                  return { success: true, message: 'Selected "' + option.textContent + '"' };
                } else {
                  return { success: false, error: 'Option not found: ' + newValue };
                }
              } catch (e) {
                return { success: false, error: e.message };
              }
            }
          `,
          arguments: [{ value }],
          returnByValue: true,
        });
      } else if (elInfo.contentEditable) {
        // Contenteditable elements
        return cdpClient.send<{
          result: { value: { success: boolean; message?: string; error?: string } };
        }>(page, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `
            function(newValue) {
              try {
                const el = this;
                el.focus();
                el.textContent = String(newValue);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return { success: true, message: 'Set content to "' + newValue + '"' };
              } catch (e) {
                return { success: false, error: e.message };
              }
            }
          `,
          arguments: [{ value }],
          returnByValue: true,
        });
      } else {
        return {
          result: {
            value: { success: false, error: `Element is not editable: ${elInfo.tagName}` },
          },
        } as { result: { value: { success: boolean; message?: string; error?: string } } };
      }
    });

    const response = result.result.value;

    if (response.success) {
      return {
        content: [{ type: 'text', text: (response.message || 'Value set successfully') + delta }],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${response.error || 'Failed to set value'}`,
          },
        ],
        isError: true,
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Form input error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerFormInputTool(server: MCPServer): void {
  server.registerTool('form_input', handler, definition);
}
