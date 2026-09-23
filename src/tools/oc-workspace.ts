import type { MCPServer } from '../mcp-server';
import type { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';

const definition: MCPToolDefinition = {
  name: 'oc_workspace',
  description: 'Open, list, or close a browser workspace. On MCP 2026-07-28 (stateless) connections every browser tool needs the `workspace` handle this returns: call action="open" once, then pass the handle on each browser call. The handle survives reconnects but not a server restart.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'list', 'close'], description: 'open returns a new handle; list shows your open workspaces; close disposes one. Default: open.' },
      workspace: { type: 'string', description: '(close) Workspace handle to close.' },
    },
    required: [],
  },
  annotations: TOOL_ANNOTATIONS.oc_workspace,
};

export function registerOcWorkspaceTool(server: MCPServer): void {
  const handler: ToolHandler = async (
    _sessionId: string,
    args: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<MCPResult> => server.handleWorkspaceTool(args, context?.principal);
  server.registerTool(definition.name, handler, definition);
}
