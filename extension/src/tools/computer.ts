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

  /**
   * Normalize a key name to the standard DOM key value used by CDP Input.dispatchKeyEvent.
   * Handles common aliases from macOS, Windows/Linux, and casual naming conventions.
   */
  function normalizeKey(key: string): string {
    const keyMap: Record<string, string> = {
      // Modifiers
      ctrl: 'Control',
      cmd: 'Meta',
      meta: 'Meta',
      alt: 'Alt',
      shift: 'Shift',
      // Common keys
      enter: 'Enter',
      tab: 'Tab',
      escape: 'Escape',
      esc: 'Escape',
      backspace: 'Backspace',
      delete: 'Delete',
      // Arrow keys
      up: 'ArrowUp',
      down: 'ArrowDown',
      left: 'ArrowLeft',
      right: 'ArrowRight',
      // Navigation keys
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
      // macOS conventions
      return: 'Enter',
      option: 'Alt',
      command: 'Meta',
      // Windows/Linux conventions
      super: 'Meta',
      win: 'Meta',
      windows: 'Meta',
      // Common key names
      space: 'Space',
      spacebar: 'Space',
      del: 'Delete',
      ins: 'Insert',
      insert: 'Insert',
      pgup: 'PageUp',
      pgdn: 'PageDown',
      prtsc: 'PrintScreen',
      printscreen: 'PrintScreen',
      apps: 'ContextMenu',
      contextmenu: 'ContextMenu',
      // Lock keys
      capslock: 'CapsLock',
      numlock: 'NumLock',
      scrolllock: 'ScrollLock',
      numpadenter: 'NumpadEnter',
    };

    const mapped = keyMap[key.toLowerCase()];
    if (mapped) return mapped;

    // Single characters are always valid
    if (key.length === 1) return key;

    // For multi-character keys, provide a helpful error
    const commonKeys = 'Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, F1-F12';
    const commonModifiers = 'ctrl, alt, shift, cmd/meta/command, option';
    throw new Error(
      `Unknown key: "${key}". Common keys: ${commonKeys}. Modifiers: ${commonModifiers}. ` +
      `Single characters (a-z, 0-9) are used directly.`
    );
  }

  function parseModifiers(modifierString?: string): number {
    if (!modifierString) return 0;

    let modifiers = 0;
    const parts = modifierString.toLowerCase().split('+');

    for (const part of parts) {
      const normalized = normalizeKey(part.trim());
      switch (normalized) {
        case 'Alt':
          modifiers |= 1;
          break;
        case 'Control':
          modifiers |= 2;
          break;
        case 'Meta':
          modifiers |= 4;
          break;
        case 'Shift':
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
                const mainKey = normalizeKey(parts[parts.length - 1]);
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
            let scrollX: number;
            let scrollY: number;
            let usedViewportCenter = false;

            if (coordinate) {
              [scrollX, scrollY] = coordinate;
            } else if (ref) {
              // Resolve ref to coordinates via DOM box model
              const refEntry = refIdManager.getRef(sessionId, tabId, ref);
              if (!refEntry) {
                return {
                  content: [{ type: 'text', text: `Error: Element reference ${ref} not found. Please call read_page first to get current element references.` }],
                  isError: true,
                };
              }
              try {
                await sessionManager.executeCDP(sessionId, tabId, 'DOM.scrollIntoViewIfNeeded', {
                  backendNodeId: refEntry.backendDOMNodeId,
                });
                const boxResult = await sessionManager.executeCDP<{ model: { content: number[] } }>(
                  sessionId, tabId, 'DOM.getBoxModel', { backendNodeId: refEntry.backendDOMNodeId }
                );
                scrollX = Math.round((boxResult.model.content[0] + boxResult.model.content[2]) / 2);
                scrollY = Math.round((boxResult.model.content[1] + boxResult.model.content[5]) / 2);
              } catch (e) {
                return {
                  content: [{ type: 'text', text: `Error: Could not get position for ${ref}: ${e instanceof Error ? e.message : String(e)}` }],
                  isError: true,
                };
              }
            } else {
              // Fall back to viewport center
              const layoutResult = await sessionManager.executeCDP<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
                sessionId, tabId, 'Page.getLayoutMetrics', {}
              ).catch(() => null);
              const w = layoutResult?.cssLayoutViewport?.clientWidth ?? 1280;
              const h = layoutResult?.cssLayoutViewport?.clientHeight ?? 800;
              scrollX = Math.floor(w / 2);
              scrollY = Math.floor(h / 2);
              usedViewportCenter = true;
            }

            const direction = scroll_direction || 'down';
            const amount = scroll_amount || 3;
            let deltaX = 0;
            let deltaY = 0;

            switch (direction) {
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
              x: scrollX,
              y: scrollY,
              deltaX,
              deltaY,
            });

            const centerNote = usedViewportCenter ? ' [viewport center]' : '';
            return {
              content: [
                {
                  type: 'text',
                  text: `Scrolled ${direction} at (${scrollX}, ${scrollY})${centerNote}`,
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
