import { MCPErrorCodes, type MCPResponse } from '../types/mcp';
import type { Principal } from '../auth/api-key-types';
import { PRINCIPAL_SYM } from '../middleware/auth';

export function isServerToClientResponseMessage(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    parsed.jsonrpc === '2.0' &&
    parsed.id !== undefined &&
    parsed.id !== null &&
    typeof parsed.method !== 'string' &&
    ('result' in parsed || 'error' in parsed)
  );
}

export function buildInvalidJsonRpcRequestResponse(parsed: Record<string, unknown>): MCPResponse | null {
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    parsed.jsonrpc === '2.0' &&
    typeof parsed.method === 'string'
  ) {
    return null;
  }

  return {
    jsonrpc: '2.0' as const,
    id: (parsed.id as string | number) ?? 0,
    error: {
      code: MCPErrorCodes.INVALID_REQUEST,
      message: 'Invalid JSON-RPC 2.0 request: missing jsonrpc or method field',
    },
  };
}

export function extractPrincipalAndScrub(parsed: Record<PropertyKey, unknown>): Principal | undefined {
  const principal = parsed[PRINCIPAL_SYM] as Principal | undefined;
  if ('__principal' in parsed) {
    delete (parsed as Record<string, unknown>).__principal;
  }
  return principal;
}

export function isJsonRpcNotification(parsed: Record<string, unknown>): boolean {
  return parsed.id === undefined || parsed.id === null;
}

export function isInitializedNotification(method: string): boolean {
  return method === 'notifications/initialized' || method === 'initialized';
}
