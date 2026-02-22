/**
 * Computer Tool - Mouse, keyboard, and screenshot actions
 */

import { KeyInput } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';

const definition: MCPToolDefinition = {
  name: 'computer',
  description:
    'Use mouse and keyboard to interact with a web browser, and take screenshots.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
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
          'screenshot',
          'wait',
          'scroll',
          'key',
          'scroll_to',
          'hover',
        ],
        description: 'The action to perform',
      },
      coordinate: {
        type: 'array',
        items: { type: 'number' },
        description: '(x, y) coordinates for click/scroll actions',
      },
      text: {
        type: 'string',
        description: 'Text to type or key to press',
      },
      duration: {
        type: 'number',
        description: 'Wait duration in seconds',
      },
      scroll_direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction',
      },
      scroll_amount: {
        type: 'number',
        description: 'Number of scroll wheel ticks',
      },
      ref: {
        type: 'string',
        description: 'Element reference ID (ref_N from read_page) or backendNodeId (number from DOM mode)',
      },
    },
    required: ['action', 'tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const action = args.action as string;
  const coordinate = args.coordinate as [number, number] | undefined;
  const text = args.text as string | undefined;
  const duration = args.duration as number | undefined;
  const scrollDirection = args.scroll_direction as string | undefined;
  const scrollAmount = (args.scroll_amount as number) || 3;
  const ref = args.ref as string | undefined;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId);
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    switch (action) {
      case 'screenshot': {
        const screenshot = await page.screenshot({
          encoding: 'base64',
          type: 'png',
        });

        return {
          content: [
            {
              type: 'image',
              data: screenshot,
              mimeType: 'image/png',
            },
          ],
        };
      }

      case 'left_click': {
        if (!coordinate) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for left_click' }],
            isError: true,
          };
        }

        const leftClickValidation = await validateCoordinates(page, coordinate[0], coordinate[1]);
        if (!leftClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${leftClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(coordinate[0], coordinate[1]);

        const resultText = leftClickValidation.warning
          ? `Clicked at (${coordinate[0]}, ${coordinate[1]}). Warning: ${leftClickValidation.warning}`
          : `Clicked at (${coordinate[0]}, ${coordinate[1]})`;

        return {
          content: [{ type: 'text', text: resultText }],
        };
      }

      case 'right_click': {
        if (!coordinate) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for right_click' }],
            isError: true,
          };
        }

        const rightClickValidation = await validateCoordinates(page, coordinate[0], coordinate[1]);
        if (!rightClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${rightClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(coordinate[0], coordinate[1], { button: 'right' });

        const rightClickText = rightClickValidation.warning
          ? `Right-clicked at (${coordinate[0]}, ${coordinate[1]}). Warning: ${rightClickValidation.warning}`
          : `Right-clicked at (${coordinate[0]}, ${coordinate[1]})`;

        return {
          content: [{ type: 'text', text: rightClickText }],
        };
      }

      case 'double_click': {
        if (!coordinate) {
          return {
            content: [
              { type: 'text', text: 'Error: coordinate is required for double_click' },
            ],
            isError: true,
          };
        }

        const doubleClickValidation = await validateCoordinates(page, coordinate[0], coordinate[1]);
        if (!doubleClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${doubleClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(coordinate[0], coordinate[1], { clickCount: 2 });

        const doubleClickText = doubleClickValidation.warning
          ? `Double-clicked at (${coordinate[0]}, ${coordinate[1]}). Warning: ${doubleClickValidation.warning}`
          : `Double-clicked at (${coordinate[0]}, ${coordinate[1]})`;

        return {
          content: [{ type: 'text', text: doubleClickText }],
        };
      }

      case 'triple_click': {
        if (!coordinate) {
          return {
            content: [
              { type: 'text', text: 'Error: coordinate is required for triple_click' },
            ],
            isError: true,
          };
        }

        const tripleClickValidation = await validateCoordinates(page, coordinate[0], coordinate[1]);
        if (!tripleClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${tripleClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(coordinate[0], coordinate[1], { clickCount: 3 });

        const tripleClickText = tripleClickValidation.warning
          ? `Triple-clicked at (${coordinate[0]}, ${coordinate[1]}). Warning: ${tripleClickValidation.warning}`
          : `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})`;

        return {
          content: [{ type: 'text', text: tripleClickText }],
        };
      }

      case 'hover': {
        if (!coordinate) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for hover' }],
            isError: true,
          };
        }

        const hoverValidation = await validateCoordinates(page, coordinate[0], coordinate[1]);
        if (!hoverValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${hoverValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.move(coordinate[0], coordinate[1]);

        const hoverText = hoverValidation.warning
          ? `Hovered at (${coordinate[0]}, ${coordinate[1]}). Warning: ${hoverValidation.warning}`
          : `Hovered at (${coordinate[0]}, ${coordinate[1]})`;

        return {
          content: [{ type: 'text', text: hoverText }],
        };
      }

      case 'type': {
        if (!text) {
          return {
            content: [{ type: 'text', text: 'Error: text is required for type action' }],
            isError: true,
          };
        }
        await page.keyboard.type(text);
        return {
          content: [{ type: 'text', text: `Typed: ${text}` }],
        };
      }

      case 'key': {
        if (!text) {
          return {
            content: [{ type: 'text', text: 'Error: text is required for key action' }],
            isError: true,
          };
        }
        // Handle multiple keys separated by space
        const keys = text.split(' ');
        for (const key of keys) {
          if (key.includes('+')) {
            // Handle modifier keys like ctrl+a
            const parts = key.split('+');
            const modifiers = parts.slice(0, -1);
            const mainKey = parts[parts.length - 1];

            for (const mod of modifiers) {
              await page.keyboard.down(normalizeKey(mod));
            }
            await page.keyboard.press(normalizeKey(mainKey));
            for (const mod of modifiers.reverse()) {
              await page.keyboard.up(normalizeKey(mod));
            }
          } else {
            await page.keyboard.press(normalizeKey(key));
          }
        }
        return {
          content: [{ type: 'text', text: `Pressed: ${text}` }],
        };
      }

      case 'wait': {
        // Validate duration
        if (duration !== undefined && duration < 0) {
          return {
            content: [{ type: 'text', text: 'Error: duration cannot be negative' }],
            isError: true,
          };
        }

        const waitTime = Math.min(Math.max((duration || 1) * 1000, 0), 30000);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return {
          content: [{ type: 'text', text: `Waited ${waitTime / 1000} seconds` }],
        };
      }

      case 'scroll': {
        if (!coordinate) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for scroll' }],
            isError: true,
          };
        }
        if (!scrollDirection) {
          return {
            content: [
              { type: 'text', text: 'Error: scroll_direction is required for scroll' },
            ],
            isError: true,
          };
        }

        const scrollValidation = await validateCoordinates(page, coordinate[0], coordinate[1]);
        if (!scrollValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${scrollValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.move(coordinate[0], coordinate[1]);

        const deltaMultiplier = 100;
        let deltaX = 0;
        let deltaY = 0;

        switch (scrollDirection) {
          case 'up':
            deltaY = -scrollAmount * deltaMultiplier;
            break;
          case 'down':
            deltaY = scrollAmount * deltaMultiplier;
            break;
          case 'left':
            deltaX = -scrollAmount * deltaMultiplier;
            break;
          case 'right':
            deltaX = scrollAmount * deltaMultiplier;
            break;
        }

        await page.mouse.wheel({ deltaX, deltaY });

        return {
          content: [
            {
              type: 'text',
              text: `Scrolled ${scrollDirection} at (${coordinate[0]}, ${coordinate[1]})`,
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

        const refIdManager = getRefIdManager();
        const backendNodeId = refIdManager.resolveToBackendNodeId(sessionId, tabId, ref);

        if (backendNodeId === undefined) {
          return {
            content: [{ type: 'text', text: `Error: Element ref or node ID '${ref}' not found` }],
            isError: true,
          };
        }

        // Use CDP to scroll element into view
        const cdpClient = sessionManager.getCDPClient();
        await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
          backendNodeId,
        });

        return {
          content: [{ type: 'text', text: `Scrolled to ${ref}` }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Error: Unknown action: ${action}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Computer action error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

/**
 * Validate and check coordinates against viewport bounds
 */
async function validateCoordinates(
  page: import('puppeteer-core').Page,
  x: number,
  y: number
): Promise<{ valid: boolean; warning?: string }> {
  // Check for negative coordinates
  if (x < 0 || y < 0) {
    return {
      valid: false,
      warning: `Negative coordinates (${x}, ${y}) are not allowed`,
    };
  }

  try {
    // Get viewport dimensions
    const viewport = page.viewport();
    if (viewport) {
      const { width, height } = viewport;

      if (x > width || y > height) {
        return {
          valid: true,
          warning: `Coordinates (${x}, ${y}) are outside visible viewport (${width}x${height}). The click may not hit the intended target.`,
        };
      }
    }
  } catch {
    // If we can't get viewport, just allow the operation
  }

  return { valid: true };
}

function normalizeKey(key: string): KeyInput {
  const keyMap: Record<string, KeyInput> = {
    ctrl: 'Control',
    cmd: 'Meta',
    meta: 'Meta',
    alt: 'Alt',
    shift: 'Shift',
    enter: 'Enter',
    tab: 'Tab',
    escape: 'Escape',
    esc: 'Escape',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  };

  return keyMap[key.toLowerCase()] || (key as KeyInput);
}

export function registerComputerTool(server: MCPServer): void {
  server.registerTool('computer', handler, definition);
}
