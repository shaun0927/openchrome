/**
 * Computer Tool - Mouse, keyboard, and screenshot actions
 */

import { KeyInput } from 'puppeteer-core';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getRefIdManager } from '../utils/ref-id-manager';
import { DEFAULT_SCREENSHOT_QUALITY } from '../config/defaults';

const definition: MCPToolDefinition = {
  name: 'computer',
  description: 'Use mouse and keyboard to interact with a web browser, and take screenshots.',
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
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found. Hint: The tab may have been closed or the session expired. Use navigate() to open a new tab.` }],
        isError: true,
      };
    }

    switch (action) {
      case 'screenshot': {
        try {
          const cdpSession = await (page as any).target().createCDPSession();
          try {
            const { data } = await cdpSession.send('Page.captureScreenshot', {
              format: 'webp',
              quality: DEFAULT_SCREENSHOT_QUALITY,
              optimizeForSpeed: true,
            });

            return {
              content: [
                {
                  type: 'image',
                  data,
                  mimeType: 'image/webp',
                },
              ],
            };
          } finally {
            await cdpSession.detach().catch(() => {});
          }
        } catch {
          // Fallback to Puppeteer PNG if CDP fails
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
      }

      case 'left_click': {
        let clickCoord: [number, number] | undefined = coordinate;
        let refInfo = '';

        if (ref && !coordinate) {
          const resolved = await resolveRefToCoordinates(sessionId, tabId, ref, page, sessionManager);
          if (resolved.error) return resolved.error;
          clickCoord = resolved.coord;
          refInfo = ` [${ref}]`;
        }

        if (!clickCoord) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for left_click' }],
            isError: true,
          };
        }

        if (refInfo) {
          await page.mouse.click(clickCoord[0], clickCoord[1]);
          return {
            content: [{ type: 'text', text: `Clicked element ${ref} at (${clickCoord[0]}, ${clickCoord[1]})` }],
          };
        }

        const leftClickValidation = await validateCoordinates(page, clickCoord[0], clickCoord[1]);
        if (!leftClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${leftClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(clickCoord[0], clickCoord[1]);

        const resultText = leftClickValidation.warning
          ? `Clicked at (${clickCoord[0]}, ${clickCoord[1]}). Warning: ${leftClickValidation.warning}`
          : `Clicked at (${clickCoord[0]}, ${clickCoord[1]})`;

        return {
          content: [{ type: 'text', text: resultText }],
        };
      }

      case 'right_click': {
        let clickCoord: [number, number] | undefined = coordinate;
        let refInfo = '';

        if (ref && !coordinate) {
          const resolved = await resolveRefToCoordinates(sessionId, tabId, ref, page, sessionManager);
          if (resolved.error) return resolved.error;
          clickCoord = resolved.coord;
          refInfo = ` [${ref}]`;
        }

        if (!clickCoord) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for right_click' }],
            isError: true,
          };
        }

        if (refInfo) {
          await page.mouse.click(clickCoord[0], clickCoord[1], { button: 'right' });
          return {
            content: [{ type: 'text', text: `Right-clicked element ${ref} at (${clickCoord[0]}, ${clickCoord[1]})` }],
          };
        }

        const rightClickValidation = await validateCoordinates(page, clickCoord[0], clickCoord[1]);
        if (!rightClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${rightClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(clickCoord[0], clickCoord[1], { button: 'right' });

        const rightClickText = rightClickValidation.warning
          ? `Right-clicked at (${clickCoord[0]}, ${clickCoord[1]}). Warning: ${rightClickValidation.warning}`
          : `Right-clicked at (${clickCoord[0]}, ${clickCoord[1]})`;

        return {
          content: [{ type: 'text', text: rightClickText }],
        };
      }

      case 'double_click': {
        let clickCoord: [number, number] | undefined = coordinate;
        let refInfo = '';

        if (ref && !coordinate) {
          const resolved = await resolveRefToCoordinates(sessionId, tabId, ref, page, sessionManager);
          if (resolved.error) return resolved.error;
          clickCoord = resolved.coord;
          refInfo = ` [${ref}]`;
        }

        if (!clickCoord) {
          return {
            content: [
              { type: 'text', text: 'Error: coordinate is required for double_click' },
            ],
            isError: true,
          };
        }

        if (refInfo) {
          await page.mouse.click(clickCoord[0], clickCoord[1], { clickCount: 2 });
          return {
            content: [{ type: 'text', text: `Double-clicked element ${ref} at (${clickCoord[0]}, ${clickCoord[1]})` }],
          };
        }

        const doubleClickValidation = await validateCoordinates(page, clickCoord[0], clickCoord[1]);
        if (!doubleClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${doubleClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(clickCoord[0], clickCoord[1], { clickCount: 2 });

        const doubleClickText = doubleClickValidation.warning
          ? `Double-clicked at (${clickCoord[0]}, ${clickCoord[1]}). Warning: ${doubleClickValidation.warning}`
          : `Double-clicked at (${clickCoord[0]}, ${clickCoord[1]})`;

        return {
          content: [{ type: 'text', text: doubleClickText }],
        };
      }

      case 'triple_click': {
        let clickCoord: [number, number] | undefined = coordinate;
        let refInfo = '';

        if (ref && !coordinate) {
          const resolved = await resolveRefToCoordinates(sessionId, tabId, ref, page, sessionManager);
          if (resolved.error) return resolved.error;
          clickCoord = resolved.coord;
          refInfo = ` [${ref}]`;
        }

        if (!clickCoord) {
          return {
            content: [
              { type: 'text', text: 'Error: coordinate is required for triple_click' },
            ],
            isError: true,
          };
        }

        if (refInfo) {
          await page.mouse.click(clickCoord[0], clickCoord[1], { clickCount: 3 });
          return {
            content: [{ type: 'text', text: `Triple-clicked element ${ref} at (${clickCoord[0]}, ${clickCoord[1]})` }],
          };
        }

        const tripleClickValidation = await validateCoordinates(page, clickCoord[0], clickCoord[1]);
        if (!tripleClickValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${tripleClickValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.click(clickCoord[0], clickCoord[1], { clickCount: 3 });

        const tripleClickText = tripleClickValidation.warning
          ? `Triple-clicked at (${clickCoord[0]}, ${clickCoord[1]}). Warning: ${tripleClickValidation.warning}`
          : `Triple-clicked at (${clickCoord[0]}, ${clickCoord[1]})`;

        return {
          content: [{ type: 'text', text: tripleClickText }],
        };
      }

      case 'hover': {
        let hoverCoord: [number, number] | undefined = coordinate;
        let refInfo = '';

        if (ref && !coordinate) {
          const resolved = await resolveRefToCoordinates(sessionId, tabId, ref, page, sessionManager);
          if (resolved.error) return resolved.error;
          hoverCoord = resolved.coord;
          refInfo = ` [${ref}]`;
        }

        if (!hoverCoord) {
          return {
            content: [{ type: 'text', text: 'Error: coordinate is required for hover' }],
            isError: true,
          };
        }

        if (refInfo) {
          await page.mouse.move(hoverCoord[0], hoverCoord[1]);
          return {
            content: [{ type: 'text', text: `Hovered element ${ref} at (${hoverCoord[0]}, ${hoverCoord[1]})` }],
          };
        }

        const hoverValidation = await validateCoordinates(page, hoverCoord[0], hoverCoord[1]);
        if (!hoverValidation.valid) {
          return {
            content: [{ type: 'text', text: `Error: ${hoverValidation.warning}` }],
            isError: true,
          };
        }

        await page.mouse.move(hoverCoord[0], hoverCoord[1]);

        const hoverText = hoverValidation.warning
          ? `Hovered at (${hoverCoord[0]}, ${hoverCoord[1]}). Warning: ${hoverValidation.warning}`
          : `Hovered at (${hoverCoord[0]}, ${hoverCoord[1]})`;

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
          text: `Computer action error: ${error instanceof Error ? error.message : String(error)}${
            (error instanceof Error && error.message.includes('timed out'))
              ? '. Hint: Page may still be loading. Use wait_for with type "selector" to wait for specific content, or increase timeout.'
              : ''
          }`,
        },
      ],
      isError: true,
    };
  }
};

/**
 * Resolve a ref to screen coordinates, scrolling the element into view first.
 * Returns either { coord } on success or { error } on failure.
 */
async function resolveRefToCoordinates(
  sessionId: string,
  tabId: string,
  ref: string,
  page: import('puppeteer-core').Page,
  sessionManager: ReturnType<typeof getSessionManager>
): Promise<{ coord: [number, number]; error?: never } | { coord?: never; error: MCPResult }> {
  const refIdManager = getRefIdManager();
  const backendNodeId = refIdManager.resolveToBackendNodeId(sessionId, tabId, ref);

  if (backendNodeId === undefined) {
    return {
      error: {
        content: [{ type: 'text', text: `Error: Element ref or node ID '${ref}' not found` }],
        isError: true,
      },
    };
  }

  const cdpClient = sessionManager.getCDPClient();
  try {
    await cdpClient.send(page, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId,
    });

    const { model } = await cdpClient.send<{
      model: { content: number[] };
    }>(page, 'DOM.getBoxModel', {
      backendNodeId,
    });

    const x = (model.content[0] + model.content[2]) / 2;
    const y = (model.content[1] + model.content[5]) / 2;
    return { coord: [Math.round(x), Math.round(y)] };
  } catch (e) {
    return {
      error: {
        content: [{ type: 'text', text: `Error: Could not get position for ${ref}: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      },
    };
  }
}

/**
 * Get hit element info via CDP after a coordinate-based click.
 * Returns a string like '\nHit: <button id="submit"> "Submit" [interactive]'
 * or empty string if CDP fails.
 */
async function getHitElementInfo(
  page: import('puppeteer-core').Page,
  cdpClient: ReturnType<ReturnType<typeof getSessionManager>['getCDPClient']>,
  x: number,
  y: number
): Promise<string> {
  try {
    const locationResult = await cdpClient.send<{ backendNodeId: number; nodeId: number }>(
      page,
      'DOM.getNodeForLocation',
      { x, y, includeUserAgentShadowDOM: false }
    );

    const backendNodeId = locationResult?.backendNodeId;
    if (!backendNodeId) return '';

    const { node: hitNode } = await cdpClient.send<{
      node: { localName: string; attributes: string[]; nodeType: number };
    }>(page, 'DOM.describeNode', { backendNodeId });

    const localName = hitNode.localName || '';
    const attrs = hitNode.attributes || [];

    // attrs is a flat array: [name0, val0, name1, val1, ...]
    const attrMap: Record<string, string> = {};
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      attrMap[attrs[i]] = attrs[i + 1];
    }

    const interactiveTags = new Set(['input', 'button', 'select', 'textarea', 'a']);
    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio',
      'combobox', 'listbox', 'menu', 'menuitem', 'tab', 'switch', 'slider',
    ]);

    const isHitInteractive =
      interactiveTags.has(localName) ||
      interactiveRoles.has((attrMap['role'] || '').toLowerCase());

    // Build attribute string with key attrs only
    const keyAttrs = ['id', 'class', 'role', 'aria-label', 'data-testid', 'type', 'href'];
    const attrStr = keyAttrs
      .filter((k) => attrMap[k] !== undefined)
      .map((k) => `${k}="${attrMap[k]}"`)
      .join(' ');

    // Get textContent from page by querying the element at the click coordinates
    let textContent = '';
    try {
      textContent = await page.evaluate(
        (px: number, py: number) => {
          const el = document.elementFromPoint(px, py);
          return el ? (el.textContent || '').trim().substring(0, 50) : '';
        },
        x,
        y
      );
    } catch { /* skip */ }

    // Build hit tag representation
    const openTag = attrStr ? `<${localName} ${attrStr}>` : `<${localName}>`;
    const textPart = textContent ? ` "${textContent.substring(0, 50)}"` : '';
    const interactiveFlag = isHitInteractive ? '[interactive]' : '[not interactive]';

    let hitInfo = `\nHit: ${openTag}${textPart} ${interactiveFlag}`;

    // If hit element is not interactive, find nearest interactive element
    if (!isHitInteractive) {
      try {
        const nearestInfo = await page.evaluate(
          (px: number, py: number) => {
            const offsets: [number, number][] = [
              [0, -20], [0, 20], [-20, 0], [20, 0],
              [0, -40], [0, 40], [-40, 0], [40, 0],
            ];
            for (const [dx, dy] of offsets) {
              const el = document.elementFromPoint(px + dx, py + dy);
              if (
                el &&
                el.matches(
                  'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]'
                )
              ) {
                const rect = el.getBoundingClientRect();
                const cx = Math.round(rect.x + rect.width / 2);
                const cy = Math.round(rect.y + rect.height / 2);
                return {
                  tag: el.tagName.toLowerCase(),
                  text: el.textContent?.substring(0, 40) || '',
                  x: cx,
                  y: cy,
                  dx: Math.round(cx - px),
                  dy: Math.round(cy - py),
                };
              }
            }
            return null;
          },
          x,
          y
        );

        if (nearestInfo) {
          const absDx = Math.abs(nearestInfo.dx);
          const absDy = Math.abs(nearestInfo.dy);
          let direction: string;
          let distance: number;
          if (absDy >= absDx) {
            direction = nearestInfo.dy > 0 ? 'below' : 'above';
            distance = absDy;
          } else {
            direction = nearestInfo.dx > 0 ? 'right' : 'left';
            distance = absDx;
          }
          hitInfo += `\nNearest interactive: <${nearestInfo.tag}> "${nearestInfo.text}" at (${nearestInfo.x}, ${nearestInfo.y}), ${distance}px ${direction}`;
        }
      } catch { /* silently skip */ }
    }

    return hitInfo;
  } catch {
    // CDP failed — fall back to no hit info
    return '';
  }
}

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
