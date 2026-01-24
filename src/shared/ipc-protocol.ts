/**
 * IPC Protocol - Message types for Master-Worker communication
 */

// IPC Request message format
export interface IPCRequest {
  id: string;
  method: IPCMethod;
  params: Record<string, unknown>;
  workerId: string;
}

// IPC Response message format
export interface IPCResponse {
  id: string;
  result?: unknown;
  error?: IPCError;
}

// IPC Error format
export interface IPCError {
  code: number;
  message: string;
  data?: unknown;
}

// All supported IPC methods
export type IPCMethod =
  // Session management
  | 'session/create'
  | 'session/delete'
  | 'session/get'
  | 'session/list'
  // Tab/Target management
  | 'tabs/create'
  | 'tabs/list'
  | 'tabs/close'
  // CDP command execution
  | 'cdp/execute'
  // Page operations
  | 'page/navigate'
  | 'page/screenshot'
  | 'page/evaluate'
  | 'page/click'
  | 'page/type'
  | 'page/scroll'
  | 'page/waitForSelector'
  | 'page/getAccessibilityTree'
  | 'page/setInputValue'
  // Reference management
  | 'refs/set'
  | 'refs/get'
  | 'refs/clear'
  // Worker management
  | 'worker/register'
  | 'worker/heartbeat';

// Error codes
export const IPCErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_NOT_FOUND: -40001,
  TARGET_NOT_FOUND: -40002,
  OWNERSHIP_VIOLATION: -40003,
  CHROME_NOT_CONNECTED: -40004,
  TIMEOUT: -40005,
} as const;
