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
  description: 'Set values in form elements using element reference ID from read_page or find tools.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to set form value in',
      },
      ref: {
        type: 'string',
        description: 'Element reference ID (ref_N from read_page) or backendNodeId (number from DOM mode)',
      },
      value: {
        oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
        description:
          'The value to set. For checkboxes use boolean, for selects use option value or text',
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
    const backendNodeId = refIdManager.resolveToBackendNodeId(sessionId, tabId, ref);
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

    // Set the value based on element type with DOM delta capture
    const { result, delta } = await withDomDelta(page, () =>
      cdpClient.send<{
        result: { value: { success: boolean; message?: string; error?: string } };
      }>(page, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `
          function(newValue) {
            try {
              const el = this;
              const tagName = el.tagName.toLowerCase();
              const type = el.type?.toLowerCase();

              if (tagName === 'input' || tagName === 'textarea') {
                if (type === 'checkbox' || type === 'radio') {
                  // For checkboxes and radios
                  const shouldCheck = typeof newValue === 'boolean' ? newValue : newValue === 'true' || newValue === true;
                  if (el.checked !== shouldCheck) {
                    el.checked = shouldCheck;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  return { success: true, message: 'Set to ' + shouldCheck };
                } else {
                  // For text inputs
                  el.focus();
                  el.value = String(newValue);
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return { success: true, message: 'Set value to "' + newValue + '"' };
                }
              } else if (tagName === 'select') {
                // For select elements
                const options = Array.from(el.options);
                const option = options.find(o =>
                  o.value === String(newValue) ||
                  o.textContent?.trim() === String(newValue)
                );
                if (option) {
                  el.value = option.value;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return { success: true, message: 'Selected "' + option.textContent + '"' };
                } else {
                  return { success: false, error: 'Option not found: ' + newValue };
                }
              } else if (el.contentEditable === 'true') {
                // For contenteditable elements
                el.focus();
                el.textContent = String(newValue);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return { success: true, message: 'Set content to "' + newValue + '"' };
              } else {
                return { success: false, error: 'Element is not editable: ' + tagName };
              }
            } catch (e) {
              return { success: false, error: e.message };
            }
          }
        `,
        arguments: [{ value }],
        returnByValue: true,
      })
    );

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
