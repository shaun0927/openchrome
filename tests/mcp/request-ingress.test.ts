/// <reference types="jest" />

import {
  buildInvalidJsonRpcRequestResponse,
  extractPrincipalAndScrub,
  isInitializedNotification,
  isJsonRpcNotification,
  isServerToClientResponseMessage,
  MAX_MCP_REQUEST_ID_BYTES,
} from '../../src/mcp/request-ingress';
import { PRINCIPAL_SYM } from '../../src/middleware/auth';

describe('mcp request ingress helpers', () => {
  test('identifies server-to-client response frames before request validation', () => {
    expect(isServerToClientResponseMessage({ jsonrpc: '2.0', id: 'oc-s2c-1', result: {} })).toBe(true);
    expect(isServerToClientResponseMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(false);
  });

  test('builds invalid JSON-RPC request responses for malformed envelopes', () => {
    expect(buildInvalidJsonRpcRequestResponse({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull();
    expect(buildInvalidJsonRpcRequestResponse({ id: 123 })).toEqual({
      jsonrpc: '2.0',
      id: 123,
      error: {
        code: -32600,
        message: 'Invalid JSON-RPC 2.0 request: missing jsonrpc or method field',
      },
    });
    const oversizedId = 'x'.repeat(MAX_MCP_REQUEST_ID_BYTES + 1);
    const oversized = buildInvalidJsonRpcRequestResponse({ id: oversizedId });
    expect(oversized).toMatchObject({ id: null, error: { code: -32600 } });
    expect(Buffer.byteLength(`data: ${JSON.stringify(oversized)}\n\n`, 'utf8')).toBeLessThan(1_000);
  });

  test('rejects unsupported or oversized request ids with a null error id', () => {
    const oversizedId = 'x'.repeat(MAX_MCP_REQUEST_ID_BYTES + 1);
    const request = { jsonrpc: '2.0', method: 'tools/list' };

    expect(buildInvalidJsonRpcRequestResponse({ ...request, id: oversizedId })).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: expect.stringContaining('request id'),
      },
    });
    expect(buildInvalidJsonRpcRequestResponse({ ...request, id: { nested: true } })).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(buildInvalidJsonRpcRequestResponse({ ...request, id: Number.POSITIVE_INFINITY })).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
  });

  test('extracts transport-injected symbol principal and scrubs forgeable string principal', () => {
    const principal = { mode: 'api-key', tenantId: 'tenant-a', keyId: 'k_1', scopes: ['browser.read'] };
    const parsed: Record<PropertyKey, unknown> = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      __principal: { tenantId: 'forged' },
      [PRINCIPAL_SYM]: principal,
    };

    expect(extractPrincipalAndScrub(parsed)).toBe(principal);
    expect('__principal' in parsed).toBe(false);
  });

  test('recognizes notifications and initialized notification aliases', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 0, method: 'initialize' })).toBe(false);
    expect(isInitializedNotification('notifications/initialized')).toBe(true);
    expect(isInitializedNotification('initialized')).toBe(true);
    expect(isInitializedNotification('tools/list')).toBe(false);
  });
});
