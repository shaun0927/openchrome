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
import { formatElementMapAsText } from '../vision/screenshot-analyzer';
import { formatPerceptionSnapshotAsText } from '../vision/perception-provider';
import type { AnnotatedScreenshotResult, PerceptionSnapshot } from '../vision/types';
import { DomAnnotatorPerceptionProvider } from '../vision/providers/dom-annotator-provider';
import { OmniParserHttpProvider } from '../vision/providers/omniparser-http-provider';
import { getOmniParserProviderConfig, trackVisionUsage } from '../vision/config';

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
      format: {
        type: 'string',
        enum: ['legacy', 'snapshot', 'both'],
        description: 'Output format: legacy text+image, provider-neutral snapshot JSON, or both. Default: legacy.',
      },
      includeImage: {
        type: 'boolean',
        description: 'Include annotated image output. Defaults to true for legacy/both and false for snapshot.',
      },
      occlusionFilter: {
        type: 'boolean',
        default: false,
        description: 'When true, drops elements whose center is covered by another element via elementFromPoint. Defaults to false to preserve today\'s output; set to true for stricter accuracy.',
      },
      iframes: {
        type: 'string',
        enum: ['none', 'same-origin', 'all'],
        default: 'none',
        description: 'Frame traversal mode. "all" still respects same-origin policy; cross-origin frames are listed in iframes.skipped.',
      },
      mode: {
        type: 'string',
        enum: ['viewport', 'tiled'],
        default: 'viewport',
        description: 'viewport: today\'s single-shot capture. tiled: full document scrolled in viewport-tall steps; returns per-tile screenshots and a unified element map.',
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
    const format = (args.format as string | undefined) || 'legacy';
    if (format !== 'legacy' && format !== 'snapshot' && format !== 'both') {
      return {
        content: [{ type: 'text', text: `Error: Invalid format "${format}". Must be "legacy", "snapshot", or "both".` }],
        isError: true,
      };
    }
    const includeImage = args.includeImage !== undefined
      ? args.includeImage === true
      : format !== 'snapshot';
    const occlusionFilter = args.occlusionFilter === true;
    const iframesArg = args.iframes;
    const iframes: 'none' | 'same-origin' | 'all' =
      iframesArg === 'same-origin' || iframesArg === 'all' ? iframesArg : 'none';
    const modeArg = args.mode;
    const mode: 'viewport' | 'tiled' = modeArg === 'tiled' ? 'tiled' : 'viewport';

    const domProvider = new DomAnnotatorPerceptionProvider(page);
    const providerConfig = getOmniParserProviderConfig();
    const wantsSnapshot = format === 'snapshot' || format === 'both';
    const needsDomResult = format === 'legacy' || format === 'both' || includeImage;
    let result: AnnotatedScreenshotResult | undefined;
    let snapshot: PerceptionSnapshot | undefined;
    const fallbackWarnings: string[] = [];

    if (wantsSnapshot && providerConfig.provider === 'omniparser-http') {
      if (!providerConfig.endpointUrl) {
        fallbackWarnings.push('OmniParser HTTP provider requested but OPENCHROME_OMNIPARSER_URL is not set; using dom-annotator fallback.');
      } else {
        try {
          const provider = new OmniParserHttpProvider(page, {
            endpointUrl: providerConfig.endpointUrl,
            timeoutMs: providerConfig.timeoutMs,
            maxElements: providerConfig.maxElements,
            context,
          });
          snapshot = await provider.capture(tabId, page.url());
          trackVisionUsage(snapshot.latencyMs);
        } catch (error) {
          fallbackWarnings.push(`OmniParser HTTP provider failed: ${error instanceof Error ? error.message : String(error)}; using dom-annotator fallback.`);
        }
      }
    }

    if (needsDomResult || !snapshot) {
      const captured = await domProvider.captureAnnotated(tabId, page.url(), {
        showGrid,
        showBoundingBoxes,
        interactiveOnly,
        occlusionFilter,
        iframes,
        mode,
      });
      result = captured.result;
      if (!snapshot) snapshot = captured.snapshot;
      if (fallbackWarnings.length > 0) {
        snapshot.warnings.unshift(...fallbackWarnings);
      }
      trackVisionUsage(result.annotationTimeMs);
      console.error(`[vision_find] Analyzed tab ${tabId}: ${result.elementCount} DOM elements in ${result.annotationTimeMs}ms`);
    } else {
      console.error(`[vision_find] Analyzed tab ${tabId}: ${snapshot.elements.length} ${snapshot.provider} elements in ${snapshot.latencyMs}ms`);
    }

    const tiles = mode === 'tiled' ? (result?.tiling?.tiles ?? []) : [];
    const tileNote =
      mode === 'tiled' && tiles.length > 0
        ? `

Tiled mode: ${tiles.length} tile screenshot(s) attached below in document-Y order.`
        : '';
    const imageBlocks =
      tiles.length > 0
        ? tiles.map((t) => ({ type: 'image' as const, data: t.imageBase64, mimeType: t.mimeType }))
        : result
          ? [{ type: 'image' as const, data: result.screenshot, mimeType: result.mimeType }]
          : [];

    const content: MCPResult['content'] = [];
    if (format === 'legacy' || format === 'both') {
      if (!result) {
        const captured = await domProvider.captureAnnotated(tabId, page.url(), {
          showGrid,
          showBoundingBoxes,
          interactiveOnly,
        });
        result = captured.result;
      }
      const textMap = formatElementMapAsText(result.elementMap);
      content.push({
        type: 'text',
        text: `Vision analysis: ${result.elementCount} elements found (${result.viewport.width}x${result.viewport.height} viewport, ${result.annotationTimeMs}ms)${tileNote}

${textMap}`,
      });
    }
    if (wantsSnapshot) {
      content.push({
        type: 'text',
        text: formatPerceptionSnapshotAsText(snapshot),
      });
    }
    if (includeImage) {
      content.push(...imageBlocks);
    }

    return { content };
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
