/**
 * Form input tool for MCP - Set values in form elements
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';
import { getRefIdManager } from '../ref-id-manager';

export function createFormInputTool(sessionManager: SessionManager) {
  const refIdManager = getRefIdManager();

  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const tabId = params.tabId as number;
      const ref = params.ref as string;
      const value = params.value as string | boolean | number;

      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'Error: sessionId is required' }],
          isError: true,
        };
      }

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

      // Validate tab ownership
      if (!sessionManager.validateTabOwnership(sessionId, tabId)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Tab ${tabId} does not belong to session ${sessionId}`,
            },
          ],
          isError: true,
        };
      }

      try {
        // Look up the ref in the RefIdManager to get the backendDOMNodeId
        const refEntry = refIdManager.getRef(sessionId, tabId, ref);
        if (!refEntry) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Element reference ${ref} not found. Please call read_page first to get current element references.`,
              },
            ],
            isError: true,
          };
        }

        // Resolve the backendDOMNodeId to a DOM node object ID
        const resolveResult = await sessionManager.executeCDP<{ object?: { objectId: string } }>(
          sessionId,
          tabId,
          'DOM.resolveNode',
          { backendNodeId: refEntry.backendDOMNodeId }
        );

        if (!resolveResult.object?.objectId) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Could not resolve element ${ref}. The element may have been removed from the page.`,
              },
            ],
            isError: true,
          };
        }

        const objectId = resolveResult.object.objectId;

        // Call a function on the element to set its value
        const result = await sessionManager.executeCDP<{ result: { value: unknown } }>(
          sessionId,
          tabId,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `
              function(value) {
                const element = this;
                const tagName = element.tagName.toLowerCase();
                const inputType = (element.type || '').toLowerCase();

                if (tagName === 'input' || tagName === 'textarea') {
                  if (inputType === 'checkbox' || inputType === 'radio') {
                    element.checked = Boolean(value);
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                  } else {
                    element.value = String(value);
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                } else if (tagName === 'select') {
                  const valueStr = String(value);
                  let found = false;
                  for (const option of element.options) {
                    if (option.value === valueStr || option.text === valueStr) {
                      option.selected = true;
                      found = true;
                      break;
                    }
                  }
                  if (!found) {
                    return { error: 'Option not found: ' + valueStr };
                  }
                  element.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (element.contentEditable === 'true') {
                  element.textContent = String(value);
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                }

                return { success: true, tagName, inputType, value: String(value) };
              }
            `,
            arguments: [{ value }],
            returnByValue: true,
          }
        );

        const evalResult = result.result.value as { success?: boolean; error?: string; tagName?: string };

        if (evalResult.error) {
          return {
            content: [{ type: 'text', text: `Error: ${evalResult.error}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Set ${evalResult.tagName} value to: ${value}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Form input error: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'form_input',
      description: 'Set values in form elements using element reference ID from the read_page tool.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to set form value in',
          },
          ref: {
            type: 'string',
            description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")',
          },
          value: {
            type: 'string',
            description: 'The value to set. For checkboxes use "true"/"false", for selects use option value or text.',
          },
        },
        required: ['sessionId', 'tabId', 'ref', 'value'],
      },
    } as MCPToolDefinition,
  };
}
