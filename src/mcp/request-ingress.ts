import { MCPErrorCodes, type MCPResponse } from '../types/mcp';
import type { Principal } from '../auth/api-key-types';
import { PRINCIPAL_SYM } from '../middleware/auth';

export const MAX_MCP_REQUEST_ID_BYTES = 256;

function boundedErrorResponseId(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value === 'string'
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MCP_REQUEST_ID_BYTES
  ) {
    return value;
  }
  return null;
}

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
  const hasRequestEnvelope = (
    typeof parsed === 'object' &&
    parsed !== null &&
    parsed.jsonrpc === '2.0' &&
    typeof parsed.method === 'string'
  );

  if (hasRequestEnvelope) {
    const id = parsed.id;
    if (id === undefined || id === null) return null;
    if (boundedErrorResponseId(id) !== null) return null;

    return {
      jsonrpc: '2.0' as const,
      id: null,
      error: {
        code: MCPErrorCodes.INVALID_REQUEST,
        message: `Invalid JSON-RPC 2.0 request id: expected a finite number or at most ${MAX_MCP_REQUEST_ID_BYTES} encoded bytes`,
      },
    };
  }

  return {
    jsonrpc: '2.0' as const,
    id: boundedErrorResponseId(parsed.id),
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
