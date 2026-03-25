/**
 * Page Screenshot Tool - Capture screenshot from current page
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'page_screenshot',
  description: 'Save page screenshot to file or return as base64. Supports full-page capture, region clipping, and multiple image formats.',
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

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  // Validate quality
  if (quality < 0 || quality > 100) {
    return {
      content: [{ type: 'text', text: 'Error: quality must be between 0 and 100' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'page_screenshot');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
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
      const viewport = page.viewport();
      const width = clip ? clip.width : (viewport?.width ?? 0);
      const height = clip ? clip.height : (fullPage ? 'full' : (viewport?.height ?? 0));

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
      // Check size before returning base64 (5MB limit)
      const fiveMB = 5 * 1024 * 1024;
      if (screenshotBuffer.length > fiveMB) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Screenshot is ${Math.round(screenshotBuffer.length / 1024 / 1024 * 10) / 10}MB which exceeds the 5MB inline limit. Use the 'path' parameter to save to a file instead.`,
            },
          ],
          isError: true,
        };
      }

      const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
      return {
        content: [
          {
            type: 'image',
            data: screenshotBuffer.toString('base64'),
            mimeType,
          },
        ],
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
