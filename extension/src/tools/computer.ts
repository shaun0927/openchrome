/**
 * Computer tool for MCP - Mouse, keyboard, and screenshot actions
 */

import type { MCPResult, MCPToolDefinition } from '../types/mcp';
import { SessionManager } from '../session-manager';
import { getRefIdManager } from '../ref-id-manager';

type ActionType =
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'triple_click'
  | 'type'
  | 'key'
  | 'screenshot'
  | 'scroll'
  | 'wait'
  | 'left_click_drag'
  | 'hover'
  | 'zoom'
  | 'scroll_to';

interface ComputerParams {
  tabId: number;
  action: ActionType;
  coordinate?: [number, number];
  text?: string;
  modifiers?: string;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  scroll_amount?: number;
  duration?: number;
  start_coordinate?: [number, number];
  region?: [number, number, number, number];
  ref?: string;
  repeat?: number;
}

export function createComputerTool(sessionManager: SessionManager) {
  const refIdManager = getRefIdManager();

  async function dispatchMouseEvent(
    sessionId: string,
    tabId: number,
    type: string,
    x: number,
    y: number,
    options: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      modifiers?: number;
    } = {}
  ): Promise<void> {
    await sessionManager.executeCDP(sessionId, tabId, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: options.button || 'left',
      clickCount: options.clickCount || 1,
      modifiers: options.modifiers || 0,
    });
  }

  async function performClick(
    sessionId: string,
    tabId: number,
    x: number,
    y: number,
    options: {
      button?: 'left' | 'right';
      clickCount?: number;
      modifiers?: number;
    } = {}
  ): Promise<void> {
    const button = options.button || 'left';
    const clickCount = options.clickCount || 1;
    const modifiers = options.modifiers || 0;

    // Move to position
    await dispatchMouseEvent(sessionId, tabId, 'mouseMoved', x, y);

    // Press and release
    await dispatchMouseEvent(sessionId, tabId, 'mousePressed', x, y, {
      button,
      clickCount,
      modifiers,
    });
    await dispatchMouseEvent(sessionId, tabId, 'mouseReleased', x, y, {
      button,
      clickCount,
      modifiers,
    });
  }

  function parseModifiers(modifierString?: string): number {
    if (!modifierString) return 0;

    let modifiers = 0;
    const parts = modifierString.toLowerCase().split('+');

    for (const part of parts) {
      switch (part.trim()) {
        case 'alt':
          modifiers |= 1;
          break;
        case 'ctrl':
        case 'control':
          modifiers |= 2;
          break;
        case 'meta':
        case 'cmd':
        case 'command':
          modifiers |= 4;
          break;
        case 'shift':
          modifiers |= 8;
          break;
      }
    }

    return modifiers;
  }

  async function takeScreenshot(
    sessionId: string,
    tabId: number,
    clip?: { x: number; y: number; width: number; height: number }
  ): Promise<string> {
    const result = await sessionManager.executeCDP<{ data: string }>(
      sessionId,
      tabId,
      'Page.captureScreenshot',
      {
        format: 'png',
        clip: clip
          ? { ...clip, scale: 1 }
          : undefined,
      }
    );
    return result.data;
  }

  return {
    handler: async (sessionId: string, params: Record<string, unknown>): Promise<MCPResult> => {
      const { tabId, action, coordinate, text, modifiers, scroll_direction, scroll_amount, duration, start_coordinate, region, ref, repeat } =
        params as unknown as ComputerParams;

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

      if (!action) {
        return {
          content: [{ type: 'text', text: 'Error: action is required' }],
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
        switch (action) {
          case 'left_click':
          case 'right_click':
          case 'double_click':
          case 'triple_click': {
            if (!coordinate) {
              return {
                content: [{ type: 'text', text: 'Error: coordinate is required for click actions' }],
                isError: true,
              };
            }

            const [x, y] = coordinate;
            const button = action === 'right_click' ? 'right' : 'left';
            const clickCount =
              action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;

            await performClick(sessionId, tabId, x, y, {
              button,
              clickCount,
              modifiers: parseModifiers(modifiers),
            });

            return {
              content: [
                {
                  type: 'text',
                  text: `${action} at (${x}, ${y})`,
                },
              ],
            };
          }

          case 'hover': {
            if (!coordinate) {
              return {
                content: [{ type: 'text', text: 'Error: coordinate is required for hover' }],
                isError: true,
              };
            }

            const [x, y] = coordinate;
            await dispatchMouseEvent(sessionId, tabId, 'mouseMoved', x, y);

            return {
              content: [{ type: 'text', text: `Hovered at (${x}, ${y})` }],
            };
          }

          case 'left_click_drag': {
            if (!start_coordinate || !coordinate) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Error: start_coordinate and coordinate are required for drag',
                  },
                ],
                isError: true,
              };
            }

            const [startX, startY] = start_coordinate;
            const [endX, endY] = coordinate;

            // Move to start
            await dispatchMouseEvent(sessionId, tabId, 'mouseMoved', startX, startY);
            // Press
            await dispatchMouseEvent(sessionId, tabId, 'mousePressed', startX, startY, {
              button: 'left',
            });
            // Move to end
            await dispatchMouseEvent(sessionId, tabId, 'mouseMoved', endX, endY);
            // Release
            await dispatchMouseEvent(sessionId, tabId, 'mouseReleased', endX, endY, {
              button: 'left',
            });

            return {
              content: [
                {
                  type: 'text',
                  text: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`,
                },
              ],
            };
          }

          case 'type': {
            if (!text) {
              return {
                content: [{ type: 'text', text: 'Error: text is required for type action' }],
                isError: true,
              };
            }

            await sessionManager.executeCDP(sessionId, tabId, 'Input.insertText', {
              text,
            });

            return {
              content: [{ type: 'text', text: `Typed: "${text}"` }],
            };
          }

          case 'key': {
            if (!text) {
              return {
                content: [{ type: 'text', text: 'Error: text (key) is required for key action' }],
                isError: true,
              };
            }

            const keys = text.split(' ');
            const repeatCount = repeat || 1;

            for (let i = 0; i < repeatCount; i++) {
              for (const key of keys) {
                // Handle key combinations
                const parts = key.split('+');
                const mainKey = parts[parts.length - 1];
                const keyModifiers = parts.slice(0, -1);

                let modifierFlags = 0;
                for (const mod of keyModifiers) {
                  modifierFlags |= parseModifiers(mod);
                }

                await sessionManager.executeCDP(sessionId, tabId, 'Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  key: mainKey,
                  modifiers: modifierFlags,
                });
                await sessionManager.executeCDP(sessionId, tabId, 'Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  key: mainKey,
                  modifiers: modifierFlags,
                });
              }
            }

            return {
              content: [{ type: 'text', text: `Pressed key(s): ${text}` }],
            };
          }

          case 'screenshot': {
            const data = await takeScreenshot(sessionId, tabId);

            return {
              content: [
                {
                  type: 'image',
                  data,
                  mimeType: 'image/png',
                },
              ],
            };
          }

          case 'zoom': {
            if (!region) {
              return {
                content: [{ type: 'text', text: 'Error: region is required for zoom action' }],
                isError: true,
              };
            }

            const [x0, y0, x1, y1] = region;
            const data = await takeScreenshot(sessionId, tabId, {
              x: x0,
              y: y0,
              width: x1 - x0,
              height: y1 - y0,
            });

            return {
              content: [
                {
                  type: 'image',
                  data,
                  mimeType: 'image/png',
                },
              ],
            };
          }

          case 'scroll': {
            if (!coordinate) {
              return {
                content: [{ type: 'text', text: 'Error: coordinate is required for scroll' }],
                isError: true,
              };
            }

            const [x, y] = coordinate;
            const amount = scroll_amount || 3;
            let deltaX = 0;
            let deltaY = 0;

            switch (scroll_direction) {
              case 'up':
                deltaY = -100 * amount;
                break;
              case 'down':
                deltaY = 100 * amount;
                break;
              case 'left':
                deltaX = -100 * amount;
                break;
              case 'right':
                deltaX = 100 * amount;
                break;
            }

            await sessionManager.executeCDP(sessionId, tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x,
              y,
              deltaX,
              deltaY,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: `Scrolled ${scroll_direction} at (${x}, ${y})`,
                },
              ],
            };
          }

          case 'scroll_to': {
            if (!ref) {
              return {
                content: [{ type: 'text', text: 'Error: ref is required for scroll_to' }],
                isError: true,
              };
            }

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

            // Call scrollIntoView on the element
            await sessionManager.executeCDP(sessionId, tabId, 'Runtime.callFunctionOn', {
              objectId: resolveResult.object.objectId,
              functionDeclaration: `
                function() {
                  this.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                }
              `,
              returnByValue: true,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: `Scrolled to element ${ref} (${refEntry.role}${refEntry.name ? ': ' + refEntry.name : ''})`,
                },
              ],
            };
          }

          case 'wait': {
            const waitDuration = Math.min(duration || 1, 30);
            await new Promise((resolve) => setTimeout(resolve, waitDuration * 1000));

            return {
              content: [{ type: 'text', text: `Waited ${waitDuration} seconds` }],
            };
          }

          default:
            return {
              content: [{ type: 'text', text: `Unknown action: ${action}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Computer action error: ${message}` }],
          isError: true,
        };
      }
    },

    definition: {
      name: 'computer',
      description:
        'Use a mouse and keyboard to interact with a web browser, and take screenshots.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session ID for isolation',
          },
          tabId: {
            type: 'number',
            description: 'Tab ID to execute the action on',
          },
          action: {
            type: 'string',
            enum: [
              'left_click',
              'right_click',
              'double_click',
              'triple_click',
              'type',
              'key',
              'screenshot',
              'scroll',
              'wait',
              'left_click_drag',
              'hover',
              'zoom',
              'scroll_to',
            ],
            description: 'The action to perform',
          },
          coordinate: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: '(x, y) coordinates for click, scroll, and drag end position',
          },
          text: {
            type: 'string',
            description: 'Text to type or key(s) to press',
          },
          modifiers: {
            type: 'string',
            description: 'Modifier keys: "ctrl", "shift", "alt", "cmd" (combined with "+")',
          },
          scroll_direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Direction to scroll',
          },
          scroll_amount: {
            type: 'number',
            minimum: 1,
            maximum: 10,
            description: 'Number of scroll wheel ticks (default: 3)',
          },
          duration: {
            type: 'number',
            minimum: 0,
            maximum: 30,
            description: 'Wait duration in seconds',
          },
          start_coordinate: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: 'Starting coordinates for drag',
          },
          region: {
            type: 'array',
            items: { type: 'number' },
            minItems: 4,
            maxItems: 4,
            description: 'Region to capture for zoom: [x0, y0, x1, y1]',
          },
          ref: {
            type: 'string',
            description: 'Element reference ID for scroll_to',
          },
          repeat: {
            type: 'number',
            minimum: 1,
            maximum: 100,
            description: 'Number of times to repeat the key sequence',
          },
        },
        required: ['sessionId', 'tabId', 'action'],
      },
    } as MCPToolDefinition,
  };
}
