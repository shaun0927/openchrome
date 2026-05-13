/**
 * oc_output_fetch — redeem an output handle created by a large-output tool.
 *
 * Tier 1 MCP tool (always exposed). Supports offset/limit pagination for
 * both JSON-array payloads (item-based) and binary/blob payloads (byte-range).
 *
 * Part of issue #887: 2-stage fetch with output handles for large-output tools.
 * P2: default callers are unaffected — this tool only activates when a handle
 * was explicitly requested via output_mode='handle'|'auto'.
 * P4: pure storage retrieval, no LLM call.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getHandleStore } from '../core/output/handle-store';
import type { OutputHandle } from '../core/output/handle-store.types';

const definition: MCPToolDefinition = {
  name: 'oc_output_fetch',
  description:
    'Redeem an output handle returned by a large-output tool (read_page, crawl, ' +
    'network, extract_data, oc_evidence_bundle). Supports offset/limit pagination ' +
    'for JSON arrays (item-based) and binary blobs (byte-range). ' +
    'Returns eof=true and next_offset=null when the last page has been read.',
  inputSchema: {
    type: 'object',
    properties: {
      output_handle: {
        type: 'string',
        description: 'REQUIRED Handle identifier returned by a large-output tool (e.g. "oh_ABCDEFGHIJKL").',
      },
      offset: {
        type: 'number',
        description: 'Byte offset (binary) or item index (JSON array). Default: 0.',
      },
      limit: {
        type: 'number',
        description:
          'Max items (JSON array) or bytes (binary/non-array JSON) to return per page. ' +
          'Default: 200 items for JSON arrays, 65536 bytes for blobs.',
      },
      format: {
        type: 'string',
        enum: ['bytes', 'items', 'auto'],
        description:
          '"auto" (default): JSON arrays use item pagination, blobs use byte-range. ' +
          '"items": force item pagination (JSON arrays only). ' +
          '"bytes": force byte-range pagination.',
      },
    },
    required: ['output_handle'],
  },
};

const handler: ToolHandler = async (
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<MCPResult> => {
  const rawHandle = args.output_handle as string | undefined;

  if (!rawHandle || typeof rawHandle !== 'string') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: { code: 'invalid_argument', message: 'output_handle is required' },
          }),
        },
      ],
      isError: true,
    };
  }

  const handle = rawHandle as OutputHandle;
  const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0;
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined;
  const format = (args.format as 'bytes' | 'items' | 'auto' | undefined) ?? 'auto';

  const store = getHandleStore();
  const result = store.fetch(handle, { offset, limit, format });

  if (!result) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'output_handle_not_found',
              message: `Handle "${handle}" not found or has expired. Handles expire after their TTL (default 24 h).`,
            },
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result),
      },
    ],
  };
};

export function registerOcOutputFetchTool(server: MCPServer): void {
  server.registerTool('oc_output_fetch', handler, definition);
}
