/**
 * Drag and Drop Tool - Perform drag and drop operations
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

interface Position {
  x: number;
  y: number;
}

const definition: MCPToolDefinition = {
  name: 'drag_drop',
  description: 'Drag and drop by selector or coordinates.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to perform drag and drop on',
      },
      sourceSelector: {
        type: 'string',
        description: 'Source element CSS selector',
      },
      sourceX: {
        type: 'number',
        description: 'Source X (alternative to selector)',
      },
      sourceY: {
        type: 'number',
        description: 'Source Y (alternative to selector)',
      },
      targetSelector: {
        type: 'string',
        description: 'Target drop zone CSS selector',
      },
      targetX: {
        type: 'number',
        description: 'Target X (alternative to selector)',
      },
      targetY: {
        type: 'number',
        description: 'Target Y (alternative to selector)',
      },
      steps: {
        type: 'number',
        description: 'Intermediate drag steps. Default: 10',
      },
      delay: {
        type: 'number',
        description: 'Delay in ms between steps. Default: 10',
      },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const sourceSelector = args.sourceSelector as string | undefined;
  const sourceX = args.sourceX as number | undefined;
  const sourceY = args.sourceY as number | undefined;
  const targetSelector = args.targetSelector as string | undefined;
  const targetX = args.targetX as number | undefined;
  const targetY = args.targetY as number | undefined;
  const steps = (args.steps as number | undefined) ?? 10;
  const delay = (args.delay as number | undefined) ?? 10;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  // Validate source
  const hasSourceSelector = sourceSelector !== undefined;
  const hasSourceCoords = sourceX !== undefined && sourceY !== undefined;
  if (!hasSourceSelector && !hasSourceCoords) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Either sourceSelector or both sourceX and sourceY are required',
        },
      ],
      isError: true,
    };
  }

  // Validate target
  const hasTargetSelector = targetSelector !== undefined;
  const hasTargetCoords = targetX !== undefined && targetY !== undefined;
  if (!hasTargetSelector && !hasTargetCoords) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Either targetSelector or both targetX and targetY are required',
        },
      ],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'drag_drop');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Get source position
    let source: Position;
    if (hasSourceSelector) {
      const sourceElement = await page.$(sourceSelector!);
      if (!sourceElement) {
        return {
          content: [{ type: 'text', text: `Error: Source element not found: ${sourceSelector}` }],
          isError: true,
        };
      }

      const sourceBox = await sourceElement.boundingBox();
      if (!sourceBox) {
        return {
          content: [{ type: 'text', text: 'Error: Could not get source element position' }],
          isError: true,
        };
      }

      source = {
        x: sourceBox.x + sourceBox.width / 2,
        y: sourceBox.y + sourceBox.height / 2,
      };
    } else {
      source = { x: sourceX!, y: sourceY! };
    }

    // Get target position
    let target: Position;
    if (hasTargetSelector) {
      const targetElement = await page.$(targetSelector!);
      if (!targetElement) {
        return {
          content: [{ type: 'text', text: `Error: Target element not found: ${targetSelector}` }],
          isError: true,
        };
      }

      const targetBox = await targetElement.boundingBox();
      if (!targetBox) {
        return {
          content: [{ type: 'text', text: 'Error: Could not get target element position' }],
          isError: true,
        };
      }

      target = {
        x: targetBox.x + targetBox.width / 2,
        y: targetBox.y + targetBox.height / 2,
      };
    } else {
      target = { x: targetX!, y: targetY! };
    }

    // Try CDP-based drag and drop first
    let usedCDP = false;
    try {
      let dragTid: ReturnType<typeof setTimeout>;
      await Promise.race([
        (async () => {
          const client = await page.createCDPSession();
          try {
            // Dispatch drag events via CDP
            await client.send('Input.dispatchDragEvent', {
              type: 'dragEnter',
              x: target.x,
              y: target.y,
              data: {
                items: [],
                dragOperationsMask: 1,
              },
            });

            await client.send('Input.dispatchDragEvent', {
              type: 'dragOver',
              x: target.x,
              y: target.y,
              data: {
                items: [],
                dragOperationsMask: 1,
              },
            });

            await client.send('Input.dispatchDragEvent', {
              type: 'drop',
              x: target.x,
              y: target.y,
              data: {
                items: [],
                dragOperationsMask: 1,
              },
            });
          } finally {
            await client.detach().catch(() => {});
          }
        })().finally(() => clearTimeout(dragTid)),
        new Promise<never>((_, reject) => {
          dragTid = setTimeout(() => reject(new Error('Drag operation timed out')), 10000);
        }),
      ]);
      usedCDP = true;
    } catch {
      // CDP drag events not supported or timed out, fall back to mouse simulation
      usedCDP = false;
    }

    // Fallback: Mouse-based drag and drop
    if (!usedCDP) {
      // Move to source
      await page.mouse.move(source.x, source.y);
      await new Promise((r) => setTimeout(r, 50));

      // Mouse down
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 50));

      // Move in steps to target
      for (let i = 1; i <= steps; i++) {
        const x = source.x + ((target.x - source.x) * i) / steps;
        const y = source.y + ((target.y - source.y) * i) / steps;
        await page.mouse.move(x, y);
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      // Mouse up
      await page.mouse.up();
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'drag_drop',
            source: hasSourceSelector
              ? { selector: sourceSelector, position: source }
              : { position: source },
            target: hasTargetSelector
              ? { selector: targetSelector, position: target }
              : { position: target },
            method: usedCDP ? 'cdp' : 'mouse',
            steps,
            message: `Dragged from (${Math.round(source.x)}, ${Math.round(source.y)}) to (${Math.round(target.x)}, ${Math.round(target.y)})`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Drag and drop error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerDragDropTool(server: MCPServer): void {
  server.registerTool('drag_drop', handler, definition);
}
