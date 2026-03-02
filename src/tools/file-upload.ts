/**
 * File Upload Tool - Upload files to file input elements
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'file_upload',
  description: 'Upload files to a file input element on the page.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to upload files to',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for the file input element (e.g., "input[type=file]")',
      },
      filePaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of file paths to upload (absolute or relative to home)',
      },
    },
    required: ['tabId', 'selector', 'filePaths'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const selector = args.selector as string;
  const filePaths = args.filePaths as string[];

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  if (!selector) {
    return {
      content: [{ type: 'text', text: 'Error: selector is required' }],
      isError: true,
    };
  }

  if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: filePaths array is required and must not be empty' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'file_upload');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Resolve and validate file paths
    const resolvedPaths: string[] = [];
    const fileInfo: Array<{ name: string; size: number }> = [];

    for (const filePath of filePaths) {
      let resolvedPath = filePath;

      // Resolve ~ to home directory
      if (filePath.startsWith('~')) {
        resolvedPath = path.join(os.homedir(), filePath.slice(1));
      } else if (process.platform === 'win32' && filePath.startsWith('%USERPROFILE%')) {
        const rest = filePath.slice('%USERPROFILE%'.length).replace(/^[/\\]+/, '');
        resolvedPath = path.join(os.homedir(), rest);
      } else if (!path.isAbsolute(filePath)) {
        resolvedPath = path.resolve(filePath);
      }

      // Check if file exists
      try {
        const stats = await fs.stat(resolvedPath);
        if (!stats.isFile()) {
          return {
            content: [{ type: 'text', text: `Error: ${resolvedPath} is not a file` }],
            isError: true,
          };
        }
        resolvedPaths.push(resolvedPath);
        fileInfo.push({
          name: path.basename(resolvedPath),
          size: stats.size,
        });
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${resolvedPath}` }],
          isError: true,
        };
      }
    }

    // Find the file input element
    const fileInput = await page.$(selector);
    if (!fileInput) {
      return {
        content: [{ type: 'text', text: `Error: File input not found: ${selector}` }],
        isError: true,
      };
    }

    // Verify it's a file input
    const isFileInput = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.tagName.toLowerCase() === 'input' && (el as HTMLInputElement).type === 'file';
    }, selector);

    if (!isFileInput) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Element at ${selector} is not a file input`,
          },
        ],
        isError: true,
      };
    }

    // Check if input accepts multiple files
    const acceptsMultiple = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      return el?.multiple ?? false;
    }, selector);

    if (resolvedPaths.length > 1 && !acceptsMultiple) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: File input does not accept multiple files, but multiple paths provided',
          },
        ],
        isError: true,
      };
    }

    // Upload files - cast to HTMLInputElement handle
    const inputHandle = fileInput as import('puppeteer-core').ElementHandle<HTMLInputElement>;
    await inputHandle.uploadFile(...resolvedPaths);

    // Get total size
    const totalSize = fileInfo.reduce((sum, f) => sum + f.size, 0);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'file_upload',
            selector,
            files: fileInfo,
            count: fileInfo.length,
            totalSizeKB: Math.round(totalSize / 1024),
            message: `Uploaded ${fileInfo.length} file(s): ${fileInfo.map((f) => f.name).join(', ')}`,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `File upload error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerFileUploadTool(server: MCPServer): void {
  server.registerTool('file_upload', handler, definition);
}
