/// <reference types="jest" />

import {
  buildInvalidJsonRpcRequestResponse,
  extractPrincipalAndScrub,
  isInitializedNotification,
  isJsonRpcNotification,
  isServerToClientResponseMessage,
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
