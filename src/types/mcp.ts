/**
 * MCP Protocol Types - Ported from extension
 */

export interface MCPRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: MCPResult;
  error?: MCPError;
}

export interface MCPResult {
  [key: string]: unknown;
  content?: MCPContent[];
  isError?: boolean;
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
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
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Context passed to tool handlers for budget-aware execution.
 * Tools can use getRemainingBudget() to check how much time remains
 * before the tool execution timeout fires.
 */
export interface ToolContext {
  /** When the tool handler started executing */
  startTime: number;
  /** Total budget in milliseconds (default: DEFAULT_TOOL_EXECUTION_TIMEOUT_MS) */
  deadlineMs: number;
}

/** Returns the number of milliseconds remaining before the tool deadline. */
export function getRemainingBudget(ctx: ToolContext): number {
  return Math.max(0, ctx.deadlineMs - (Date.now() - ctx.startTime));
}

/** Returns true if at least `needed` ms remain before the tool deadline. */
export function hasBudget(ctx: ToolContext, needed = 0): boolean {
  return getRemainingBudget(ctx) > needed;
}

export type ToolHandler = (
  sessionId: string,
  params: Record<string, unknown>,
  context?: ToolContext
) => Promise<MCPResult>;

export interface ToolRegistry {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
  /** When true, timeout errors return isError:false (tool produced useful partial state). */
  timeoutRecoverable?: boolean;
}

export const MCPErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** LLM-side override for compression level on individual tool calls */
export type CompressionOverride = 'none' | 'light' | 'aggressive';
