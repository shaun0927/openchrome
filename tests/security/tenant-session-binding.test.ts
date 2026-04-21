/// <reference types="jest" />
// Regression guard for Codex round-4 P1 (PR #28): an authenticated tenant
// must not be able to operate on a session already claimed by a different
// tenant. The PR-scope defense-in-depth is a per-session tenant map in
// MCPServer; structural binding (at session-create time) lands later.
//
// Full HTTP E2E coverage is explicitly deferred to PR 4/4 per the PR
// description; this suite asserts the core invariant at the MCPServer
// layer directly.

import { MCPServer } from '../../src/mcp-server';
import type { Principal } from '../../src/auth/api-key-types';
import { PRINCIPAL_SYM } from '../../src/middleware/auth';

const originalEnv = { ...process.env };

function principal(tenantId: string, scopes: Principal['scopes'] = ['read', 'write']): Principal {
  return { tenantId, scopes, mode: 'api-key', keyId: `k_${tenantId.slice(0, 8)}` };
}

function msg(method: string, params: Record<string, unknown>, p: Principal, id = 1): Record<PropertyKey, unknown> {
  const m: Record<PropertyKey, unknown> = { jsonrpc: '2.0', id, method, params };
  m[PRINCIPAL_SYM] = p;
  return m;
}

describe('tenant-session binding (MCPServer)', () => {
  let server: MCPServer;

  beforeAll(() => {
    // Avoid Chrome/CDP auto-launch for this unit-level test.
    process.env.OPENCHROME_AUTO_LAUNCH = 'false';
    process.env.OPENCHROME_RATE_LIMIT_RPM = '0';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    server = new MCPServer();
    server.registerTool(
      'noop',
      async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }),
      {
        name: 'noop',
        description: 'test helper',
        inputSchema: { type: 'object', properties: {} },
      },
    );
  });

  it('first api-key caller claims the session; same tenant is allowed to re-enter', async () => {
    const alice = principal('alice');
    // Use a trivial read-only tool so we can avoid heavy fixtures.
    const r1 = await server.handleMessage(
      msg('tools/call', { name: 'noop', arguments: { sessionId: 's-1' } }, alice),
    );
    expect(r1).not.toBeNull();
    // Shape: response is a JSON-RPC response (may be error or success — we don't
    // care here, only that it isn't the 403-tenant-binding error).
    const body1 = JSON.stringify(r1);
    expect(body1).not.toContain('owned by another tenant');

    const r2 = await server.handleMessage(
      msg('tools/call', { name: 'noop', arguments: { sessionId: 's-1' } }, alice, 2),
    );
    const body2 = JSON.stringify(r2);
    expect(body2).not.toContain('owned by another tenant');
  }, 20000);

  it('second tenant is rejected with 403-equivalent error on the claimed session', async () => {
    const alice = principal('alice');
    const bob = principal('bob');
    await server.handleMessage(
      msg('tools/call', { name: 'noop', arguments: { sessionId: 's-2' } }, alice),
    );
    const resp = await server.handleMessage(
      msg('tools/call', { name: 'noop', arguments: { sessionId: 's-2' } }, bob, 2),
    );
    expect(resp).not.toBeNull();
    const body = JSON.stringify(resp);
    expect(body).toContain('owned by another tenant');
    expect(body).toContain('s-2');
  }, 20000);

  it('disabled / legacy principals are unaffected (no binding enforced)', async () => {
    const disabled: Principal = { tenantId: 'anonymous', scopes: ['admin'], mode: 'disabled' };
    const legacy: Principal = { tenantId: 'legacy', scopes: ['admin'], mode: 'legacy' };
    // Both "tenants" share the legacy synthetic id but must still coexist.
    const r1 = await server.handleMessage(
      msg('tools/call', { name: 'noop', arguments: { sessionId: 's-3' } }, disabled),
    );
    const r2 = await server.handleMessage(
      msg('tools/call', { name: 'noop', arguments: { sessionId: 's-3' } }, legacy, 2),
    );
    expect(JSON.stringify(r1)).not.toContain('owned by another tenant');
    expect(JSON.stringify(r2)).not.toContain('owned by another tenant');
  }, 20000);

  it('stdio callers (no principal) are unaffected', async () => {
    const m: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait_for', arguments: { sessionId: 's-4', condition: 'timeout', timeoutMs: 1 } },
    };
    const resp = await server.handleMessage(m);
    expect(JSON.stringify(resp)).not.toContain('owned by another tenant');
  }, 20000);
});
