/**
 * Page Screenshot Tool - Capture screenshot from current page
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import {
  bufferToBase64WithPayloadGuard,
  resolveViewportDimensions,
  validateCaptureArea,
} from '../utils/screenshot-guards';
import { withTimeout } from '../utils/with-timeout';
import { makeImageContent, type SupportedImageMimeType } from '../utils/image-mime';

const FULL_PAGE_DIMENSION_TIMEOUT_MS = 5000;

const definition: MCPToolDefinition = {
  name: 'page_screenshot',
  description: 'Save page screenshot to file or return as base64. Supports full-page capture, region clipping, and multiple image formats.\n\nWhen to use: Capturing a screenshot for saving to disk or when the full-page or clipped region is needed.\nWhen NOT to use: Use computer(action:"screenshot") for an inline viewport screenshot during interaction.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to capture',
      },
      path: {
        type: 'string',
        description: 'Save path. Omit for base64 return',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture entire scrollable page. Default: false',
      },
      format: {
        type: 'string',
        enum: ['png', 'webp', 'jpeg'],
        description: 'Image format. Default: png',
      },
      quality: {
        type: 'number',
        description: 'Compression quality 0-100, for jpeg/webp only. Default: 80',
      },
      clip: {
        type: 'object',
        description: 'Capture specific region',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
      omitBackground: {
        type: 'boolean',
        description: 'Transparent background (png only). Default: false',
      },
    },
    required: ['tabId'],
  },
  annotations: TOOL_ANNOTATIONS.page_screenshot,
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const filePath = args.path as string | undefined;
  const fullPage = (args.fullPage as boolean | undefined) ?? false;
  const format = (args.format as string | undefined) ?? 'png';
  const quality = (args.quality as number | undefined) ?? 80;
  const clip = args.clip as { x: number; y: number; width: number; height: number } | undefined;
  const omitBackground = (args.omitBackground as boolean | undefined) ?? false;

  const makeError = (text: string): MCPResult => ({
    content: [{ type: 'text', text }],
    isError: true,
  });

  const sessionManager = getSessionManager();

  if (!tabId) {
    return makeError('Error: tabId is required');
  }

  // Validate quality
  if (quality < 0 || quality > 100) {
    return makeError('Error: quality must be between 0 and 100');
  }

  if (clip && (!Number.isFinite(clip.x) || !Number.isFinite(clip.y) || !Number.isFinite(clip.width) || !Number.isFinite(clip.height) || clip.width <= 0 || clip.height <= 0)) {
    return makeError('Error: clip x, y, width, and height must be finite numbers, and clip width/height must be greater than 0');
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'page_screenshot');
    if (!page) {
      return makeError(`Error: Tab ${tabId} not found`);
    }

    const captureDimensions = clip
      ? { width: clip.width, height: clip.height }
      : fullPage
        ? await withTimeout(
            page.evaluate(() => ({
              width: Math.max(
                document.documentElement?.scrollWidth ?? 0,
                document.body?.scrollWidth ?? 0,
                window.innerWidth ?? 0
              ),
              height: Math.max(
                document.documentElement?.scrollHeight ?? 0,
                document.body?.scrollHeight ?? 0,
                window.innerHeight ?? 0
              ),
            })),
            FULL_PAGE_DIMENSION_TIMEOUT_MS,
            'Full-page dimension lookup'
          )
        : await resolveViewportDimensions(page);

    const areaLabel = clip ? 'Clipped screenshot' : fullPage ? 'Full-page screenshot' : 'Screenshot';
    const areaError = validateCaptureArea(captureDimensions, areaLabel);
    if (areaError) {
      return makeError(`Error: ${areaError}`);
    }

    // Build screenshot options
    const screenshotOptions: Record<string, unknown> = {
      type: format,
      fullPage,
      omitBackground,
    };

    if (format !== 'png') {
      screenshotOptions.quality = quality;
    }

    if (clip) {
      screenshotOptions.clip = clip;
      screenshotOptions.fullPage = false; // clip overrides fullPage
    }

    // Capture screenshot (with 60s timeout)
    let tid: ReturnType<typeof setTimeout>;
    const buffer = await Promise.race([
      page.screenshot(screenshotOptions).finally(() => clearTimeout(tid)),
      new Promise<never>((_, reject) => {
        tid = setTimeout(() => reject(new Error('Screenshot capture timed out after 60000ms')), 60000);
      }),
    ]);
    const screenshotBuffer = Buffer.from(buffer);

    if (filePath) {
      // Resolve path (support ~ for home directory)
      let resolvedPath = filePath;
      if (filePath.startsWith('~')) {
        resolvedPath = path.join(os.homedir(), filePath.slice(1));
      } else if (process.platform === 'win32' && filePath.startsWith('%USERPROFILE%')) {
        const rest = filePath.slice('%USERPROFILE%'.length).replace(/^[/\\]+/, '');
        resolvedPath = path.join(os.homedir(), rest);
      } else if (!path.isAbsolute(filePath)) {
        resolvedPath = path.resolve(filePath);
      }

      // Validate the output path — block writes to sensitive directories
      const normalizedPath = path.resolve(resolvedPath);
      const homeDir = os.homedir();
      const sensitiveRoots = [
        path.join(homeDir, '.ssh'),
        path.join(homeDir, '.gnupg'),
        path.join(homeDir, '.aws'),
      ];
      if (sensitiveRoots.some(root => normalizedPath.startsWith(root + path.sep) || normalizedPath === root)) {
        return {
          content: [{ type: 'text', text: `Error: Cannot write screenshot to sensitive directory "${path.dirname(normalizedPath)}"` }],
          isError: true,
        };
      }

      // Ensure directory exists
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(resolvedPath, screenshotBuffer);

      // Determine dimensions
      const width = captureDimensions.width;
      const height = captureDimensions.height;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'page_screenshot',
              path: resolvedPath,
              format,
              sizeKB: Math.round(screenshotBuffer.length / 1024),
              dimensions: { width, height },
              message: `Screenshot saved to ${resolvedPath} (${Math.round(screenshotBuffer.length / 1024)} KB)`,
            }),
          },
        ],
      };
    } else {
      const encoded = bufferToBase64WithPayloadGuard(screenshotBuffer, 'Screenshot');
      if ('error' in encoded) {
        return makeError(`Error: ${encoded.error}`);
      }

      const mimeType: SupportedImageMimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
      return {
        content: [makeImageContent(encoded.data, mimeType)],
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Screenshot error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerPageScreenshotTool(server: MCPServer): void {
  server.registerTool('page_screenshot', handler, definition);
}
