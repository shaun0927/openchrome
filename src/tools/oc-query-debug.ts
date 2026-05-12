import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getLatestQueryDebug, QueryDebugKind } from '../query-debug/store';

const definition: MCPToolDefinition = {
  name: 'oc_query_debug',
  description: 'Return the latest bounded local query debug record for extract_data or element resolution. No full DOM/HTML is stored.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Tab ID whose latest debug record should be returned.' },
      kind: { type: 'string', enum: ['extract', 'element'], description: 'Debug record kind. Default: extract.' },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (sessionId: string, args: Record<string, unknown>): Promise<MCPResult> => {
  const tabId = args.tabId as string | undefined;
  const kind = (args.kind as QueryDebugKind | undefined) || 'extract';
  if (!tabId) {
    return { content: [{ type: 'text', text: 'Error: tabId is required' }], isError: true };
  }
  if (kind !== 'extract' && kind !== 'element') {
    return { content: [{ type: 'text', text: 'Error: kind must be "extract" or "element"' }], isError: true };
  }

  const record = getLatestQueryDebug(sessionId, tabId, kind);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(record ? { action: 'oc_query_debug', found: true, record } : { action: 'oc_query_debug', found: false, kind, tabId }),
    }],
  };
};

export function registerOcQueryDebugTool(server: MCPServer): void {
  server.registerTool('oc_query_debug', handler, definition);
}
