/**
 * Vision Find Tool - Explicit vision-based element discovery using annotated screenshots.
 *
 * Uses the screenshot analyzer to capture an annotated screenshot with numbered
 * interactive elements, returning both the image and a text element map.
 *
 * This tool is useful when DOM-based discovery (find, interact) cannot locate
 * elements — e.g. canvas apps, complex iframes, or heavily dynamic UIs.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler, ToolContext, hasBudget } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { analyzeScreenshot, formatElementMapAsText } from '../vision/screenshot-analyzer';

const definition: MCPToolDefinition = {
  name: 'vision_find',
  description: 'Find elements using vision-based screenshot analysis. Returns annotated screenshot with numbered elements.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to analyze',
      },
      instruction: {
        type: 'string',
        description: 'Optional hint about what to look for (for future use)',
      },
      showGrid: {
        type: 'boolean',
        description: 'Overlay coordinate grid on screenshot. Default: false',
      },
      showBoundingBoxes: {
        type: 'boolean',
        description: 'Show bounding boxes around elements. Default: true',
      },
      interactiveOnly: {
        type: 'boolean',
        description: 'Only show interactive elements (buttons, links, inputs). Default: true',
      },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<MCPResult> => {
  const tabId = args.tabId as string;

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  // Budget check: vision analysis needs at least 10s
  if (context && !hasBudget(context, 10_000)) {
    return {
      content: [{ type: 'text', text: 'vision_find: deadline approaching — need at least 10s budget' }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'vision_find');
    if (!page) {
      const available = await sessionManager.getAvailableTargets(sessionId);
      const availableInfo = available.length > 0
        ? `\nAvailable tabs:\n${available.map(t => `  - tabId: ${t.tabId} | ${t.url} | ${t.title}`).join('\n')}`
        : '\nNo tabs available. Call navigate without tabId to create a new tab.';
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found or no longer available.${availableInfo}` }],
        isError: true,
      };
    }

    const showGrid = args.showGrid === true;
    const showBoundingBoxes = args.showBoundingBoxes !== false;
    const interactiveOnly = args.interactiveOnly !== false;

    const result = await analyzeScreenshot(page, {
      showGrid,
      showBoundingBoxes,
      interactiveOnly,
    });

    const textMap = formatElementMapAsText(result.elementMap);
    console.error(`[vision_find] Analyzed tab ${tabId}: ${result.elementCount} elements in ${result.annotationTimeMs}ms`);

    return {
      content: [
        {
          type: 'text',
          text: `Vision analysis: ${result.elementCount} elements found (${result.viewport.width}x${result.viewport.height} viewport, ${result.annotationTimeMs}ms)\n\n${textMap}`,
        },
        {
          type: 'image',
          data: result.screenshot,
          mimeType: result.mimeType,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `vision_find error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerVisionFindTool(server: MCPServer): void {
  server.registerTool('vision_find', handler, definition);
}
