/// <reference types="jest" />
// Regression guard for Codex round-5 P1 + P2 (PR #28):
//   P1: `sessions/{list,create,delete}` must enforce scope + tenant binding
//       (previously only `tools/call` did).
//   P2: `sessions/delete` via JSON-RPC must clear the sessionTenants binding
//       so the sessionId can be reclaimed by another tenant afterwards.

import { MCPServer } from '../../src/mcp-server';
import type { Principal } from '../../src/auth/api-key-types';
import { PRINCIPAL_SYM } from '../../src/middleware/auth';

const originalEnv = { ...process.env };

function principal(tenantId: string, scopes: Principal['scopes']): Principal {
  return { tenantId, scopes, mode: 'api-key', keyId: `k_${tenantId.slice(0, 8)}` };
}

function msg(
  method: string,
  params: Record<string, unknown>,
  p?: Principal,
  id = 1,
): Record<PropertyKey, unknown> {
  const m: Record<PropertyKey, unknown> = { jsonrpc: '2.0', id, method, params };
  if (p) m[PRINCIPAL_SYM] = p;
  return m;
}

function extractResult(resp: unknown): { text: string; isError: boolean } {
  const r = resp as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  const text = r?.result?.content?.[0]?.text ?? '';
  return { text, isError: Boolean(r?.result?.isError) };
}

describe('sessions/* authz (MCPServer round-5)', () => {
  let server: MCPServer;

  beforeAll(() => {
    process.env.OPENCHROME_AUTO_LAUNCH = 'false';
    process.env.OPENCHROME_RATE_LIMIT_RPM = '0';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    server = new MCPServer();
  });

  describe('sessions/create', () => {
    it('read-only api-key is denied (scope gate)', async () => {
      const alice = principal('alice', ['read']);
      const resp = await server.handleMessage(
        msg('sessions/create', { sessionId: 's-create-1' }, alice),
      );
      const { text, isError } = extractResult(resp);
      expect(isError).toBe(true);
      expect(text).toContain("scope 'write' required");
    });

    it('write-scoped tenant that does not own the requested sessionId is rejected', async () => {
      const alice = principal('alice', ['read', 'write']);
      const bob = principal('bob', ['read', 'write']);

      // Alice claims the id first (via tools/call → sessionTenants).
      await server.handleMessage(
        msg(
          'tools/call',
          { name: 'wait_for', arguments: { sessionId: 's-create-2', condition: 'timeout', timeoutMs: 1 } },
          alice,
        ),
      );
      // Bob tries to explicitly (re)create the same id.
      const resp = await server.handleMessage(
        msg('sessions/create', { sessionId: 's-create-2' }, bob, 2),
      );
      const { text, isError } = extractResult(resp);
      expect(isError).toBe(true);
      expect(text).toContain('owned by another tenant');
    }, 20000);
  });

  describe('sessions/delete', () => {
    it('read-only api-key is denied (scope gate)', async () => {
      const alice = principal('alice', ['read']);
      const resp = await server.handleMessage(
        msg('sessions/delete', { sessionId: 's-del-1' }, alice),
      );
      const { text, isError } = extractResult(resp);
      expect(isError).toBe(true);
      expect(text).toContain("scope 'write' required");
    });

    it('tenant cannot delete a session owned by another tenant', async () => {
      const alice = principal('alice', ['read', 'write']);
      const bob = principal('bob', ['read', 'write']);
      await server.handleMessage(
        msg(
          'tools/call',
          { name: 'wait_for', arguments: { sessionId: 's-del-2', condition: 'timeout', timeoutMs: 1 } },
          alice,
        ),
      );
      const resp = await server.handleMessage(
        msg('sessions/delete', { sessionId: 's-del-2' }, bob, 2),
      );
      const { text, isError } = extractResult(resp);
      expect(isError).toBe(true);
      expect(text).toContain('owned by another tenant');
    }, 20000);

    it('successful delete releases the binding so another tenant can reclaim the id', async () => {
      const alice = principal('alice', ['read', 'write']);
      const bob = principal('bob', ['read', 'write']);
      await server.handleMessage(
        msg(
          'tools/call',
          { name: 'wait_for', arguments: { sessionId: 's-del-3', condition: 'timeout', timeoutMs: 1 } },
          alice,
        ),
      );
      // Alice deletes her own session through the MCP method — this must
      // also clear sessionTenants (round-5 P2). If it doesn't, Bob's next
      // call below would spuriously fail with "owned by another tenant".
      const del = await server.handleMessage(
        msg('sessions/delete', { sessionId: 's-del-3' }, alice, 2),
      );
      expect(extractResult(del).isError).toBe(false);

      const reclaim = await server.handleMessage(
        msg(
          'tools/call',
          { name: 'wait_for', arguments: { sessionId: 's-del-3', condition: 'timeout', timeoutMs: 1 } },
          bob,
          3,
        ),
      );
      const { text } = extractResult(reclaim);
      expect(text).not.toContain('owned by another tenant');
    }, 20000);
  });

  describe('sessions/list', () => {
    it('read-only api-key can list (scope check passes)', async () => {
      const alice = principal('alice', ['read']);
      const resp = await server.handleMessage(msg('sessions/list', {}, alice));
      expect(extractResult(resp).isError).toBe(false);
    });

    it('api-key caller only sees sessions claimed by their own tenant', async () => {
      const alice = principal('alice', ['read', 'write']);
      const bob = principal('bob', ['read', 'write']);
      await server.handleMessage(
        msg(
          'tools/call',
          { name: 'wait_for', arguments: { sessionId: 's-list-a', condition: 'timeout', timeoutMs: 1 } },
          alice,
        ),
      );
      await server.handleMessage(
        msg(
          'tools/call',
          { name: 'wait_for', arguments: { sessionId: 's-list-b', condition: 'timeout', timeoutMs: 1 } },
          bob,
          2,
        ),
      );
      const aliceList = await server.handleMessage(msg('sessions/list', {}, alice, 3));
      const bobList = await server.handleMessage(msg('sessions/list', {}, bob, 4));
      // Alice's view must not include Bob's sessionId, and vice versa.
      expect(extractResult(aliceList).text).not.toContain('s-list-b');
      expect(extractResult(bobList).text).not.toContain('s-list-a');
    }, 20000);
  });

  it('stdio callers (no principal) can still use session methods', async () => {
    const resp = await server.handleMessage(msg('sessions/list', {}));
    expect(extractResult(resp).isError).toBe(false);
  });
});
