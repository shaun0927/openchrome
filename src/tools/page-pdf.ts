/**
 * Page PDF Tool - Generate PDF from current page
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'page_pdf',
  description: `Generate a PDF from the current page.
If path is provided, saves to file. Otherwise returns base64-encoded PDF.
Supports various paper formats and options.`,
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to generate PDF from',
      },
      path: {
        type: 'string',
        description: 'File path to save PDF (absolute or relative to home). If not provided, returns base64.',
      },
      format: {
        type: 'string',
        enum: ['A4', 'Letter', 'Legal', 'Tabloid', 'A3', 'A5'],
        description: 'Paper format (default: A4)',
      },
      landscape: {
        type: 'boolean',
        description: 'Whether to print in landscape mode (default: false)',
      },
      printBackground: {
        type: 'boolean',
        description: 'Whether to print background graphics (default: true)',
      },
      scale: {
        type: 'number',
        description: 'Scale of the webpage rendering (0.1-2.0, default: 1)',
      },
      marginTop: {
        type: 'string',
        description: 'Top margin (e.g., "1cm", "0.5in")',
      },
      marginRight: {
        type: 'string',
        description: 'Right margin (e.g., "1cm", "0.5in")',
      },
      marginBottom: {
        type: 'string',
        description: 'Bottom margin (e.g., "1cm", "0.5in")',
      },
      marginLeft: {
        type: 'string',
        description: 'Left margin (e.g., "1cm", "0.5in")',
      },
      pageRanges: {
        type: 'string',
        description: 'Page ranges to print (e.g., "1-5, 8, 11-13")',
      },
      displayHeaderFooter: {
        type: 'boolean',
        description: 'Whether to display header and footer (default: false)',
      },
      headerTemplate: {
        type: 'string',
        description: 'HTML template for the header (requires displayHeaderFooter: true)',
      },
      footerTemplate: {
        type: 'string',
        description: 'HTML template for the footer (requires displayHeaderFooter: true)',
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
  const format = (args.format as string | undefined) ?? 'A4';
  const landscape = (args.landscape as boolean | undefined) ?? false;
  const printBackground = (args.printBackground as boolean | undefined) ?? true;
  const scale = (args.scale as number | undefined) ?? 1;
  const marginTop = args.marginTop as string | undefined;
  const marginRight = args.marginRight as string | undefined;
  const marginBottom = args.marginBottom as string | undefined;
  const marginLeft = args.marginLeft as string | undefined;
  const pageRanges = args.pageRanges as string | undefined;
  const displayHeaderFooter = (args.displayHeaderFooter as boolean | undefined) ?? false;
  const headerTemplate = args.headerTemplate as string | undefined;
  const footerTemplate = args.footerTemplate as string | undefined;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  // Validate scale
  if (scale < 0.1 || scale > 2.0) {
    return {
      content: [{ type: 'text', text: 'Error: scale must be between 0.1 and 2.0' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'page_pdf');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    // Build PDF options
    const pdfOptions: Parameters<typeof page.pdf>[0] = {
      format: format as 'A4' | 'Letter' | 'Legal' | 'Tabloid' | 'A3' | 'A5',
      landscape,
      printBackground,
      scale,
      displayHeaderFooter,
    };

    // Add margins if specified
    if (marginTop || marginRight || marginBottom || marginLeft) {
      pdfOptions.margin = {
        top: marginTop,
        right: marginRight,
        bottom: marginBottom,
        left: marginLeft,
      };
    }

    if (pageRanges) {
      pdfOptions.pageRanges = pageRanges;
    }

    if (displayHeaderFooter) {
      if (headerTemplate) pdfOptions.headerTemplate = headerTemplate;
      if (footerTemplate) pdfOptions.footerTemplate = footerTemplate;
    }

    // Generate PDF (with 60s timeout)
    let pdfTid: ReturnType<typeof setTimeout>;
    const pdfBuffer = await Promise.race([
      page.pdf(pdfOptions).finally(() => clearTimeout(pdfTid)),
      new Promise<never>((_, reject) => {
        pdfTid = setTimeout(() => reject(new Error('PDF generation timed out after 60000ms')), 60000);
      }),
    ]);

    if (filePath) {
      // Resolve path (support ~ for home directory)
      let resolvedPath = filePath;
      if (filePath.startsWith('~')) {
        resolvedPath = path.join(os.homedir(), filePath.slice(1));
      } else if (process.platform === 'win32' && filePath.startsWith('%USERPROFILE%')) {
        resolvedPath = path.join(os.homedir(), filePath.slice('%USERPROFILE%'.length));
      } else if (!path.isAbsolute(filePath)) {
        resolvedPath = path.resolve(filePath);
      }

      // Ensure directory exists
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(resolvedPath, pdfBuffer);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'page_pdf',
              path: resolvedPath,
              size: pdfBuffer.length,
              sizeKB: Math.round(pdfBuffer.length / 1024),
              format,
              landscape,
              message: `PDF saved to ${resolvedPath} (${Math.round(pdfBuffer.length / 1024)} KB)`,
            }),
          },
        ],
      };
    } else {
      // Return base64
      const base64 = Buffer.from(pdfBuffer).toString('base64');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              action: 'page_pdf',
              base64: base64.slice(0, 100) + '...',  // Truncate for response
              size: pdfBuffer.length,
              sizeKB: Math.round(pdfBuffer.length / 1024),
              format,
              landscape,
              message: `PDF generated (${Math.round(pdfBuffer.length / 1024)} KB). Base64 data truncated in response.`,
              fullBase64: base64,
            }),
          },
        ],
      };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `PDF error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerPagePdfTool(server: MCPServer): void {
  server.registerTool('page_pdf', handler, definition);
}
