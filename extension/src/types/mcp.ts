/**
 * MCP (Model Context Protocol) types
 */

export interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: MCPParams;
}

export interface MCPParams {
  /** Session ID for isolation */
  sessionId?: string;
  /** Tool name for tools/call */
  name?: string;
  /** Tool arguments */
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: MCPResult;
  error?: MCPError;
}

export interface MCPResult {
  content?: MCPContent[];
  tools?: MCPToolDefinition[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, MCPSchemaProperty>;
    required?: string[];
  };
}

export interface MCPSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: MCPSchemaProperty;
  properties?: Record<string, MCPSchemaProperty>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** MCP error codes */
export const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_NOT_FOUND: -32001,
  TAB_NOT_FOUND: -32002,
  CDP_ERROR: -32003,
  PERMISSION_DENIED: -32004,
} as const;

export type ToolHandler = (
  sessionId: string,
  params: Record<string, unknown>
) => Promise<MCPResult>;

export interface ToolRegistry {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}
