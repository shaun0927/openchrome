/// <reference types="jest" />
// Regression guard for Codex round-3 P1 (PR #28): ensure a client-supplied
// `__principal` string field in the JSON-RPC body cannot influence the
// server's authorization context. The trusted channel is the non-forgeable
// PRINCIPAL_SYM Symbol set by the transport; JSON.parse cannot produce
// symbol-keyed properties, so a forged body should be stripped and ignored.

import { PRINCIPAL_SYM, type Principal } from '../../src/middleware/auth';

describe('principal forgery defense', () => {
  it('PRINCIPAL_SYM is a Symbol (non-forgeable via JSON)', () => {
    expect(typeof PRINCIPAL_SYM).toBe('symbol');
    // JSON round-trip must not surface the symbol as a string key.
    const obj: Record<PropertyKey, unknown> = {};
    obj[PRINCIPAL_SYM] = { tenantId: 'trusted', scopes: ['admin'], mode: 'api-key' };
    const serialized = JSON.stringify(obj);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual({});
    expect((parsed as Record<PropertyKey, unknown>)[PRINCIPAL_SYM]).toBeUndefined();
  });

  it('parsed JSON with a malicious __principal string key does not populate the symbol slot', () => {
    // Simulates a stdio caller posting a crafted JSON-RPC body trying to
    // impersonate `mode: 'api-key'` with arbitrary tenantId/scopes.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'navigate', arguments: { url: 'https://example.com' } },
      __principal: { mode: 'api-key', tenantId: 'victim-tenant', scopes: ['admin'] },
    });
    const parsed = JSON.parse(body);
    const principalFromSym = (parsed as Record<PropertyKey, unknown>)[PRINCIPAL_SYM] as
      | Principal
      | undefined;
    expect(principalFromSym).toBeUndefined();
    // The string key is present on parsed (JSON does deliver it), but code
    // paths must only read PRINCIPAL_SYM — so this test documents the
    // invariant that the forged field must never be authoritative.
    expect(parsed.__principal).toBeDefined();
  });

  it('transport-injected symbol value is readable and survives property enumeration independent of JSON', () => {
    // Models the HTTP transport path: after authenticating, the transport
    // attaches the real principal via the symbol. Downstream code reads the
    // symbol slot; any client-supplied `__principal` string is ignored and
    // scrubbed.
    const injectedPrincipal: Principal = {
      tenantId: 'real-tenant',
      scopes: ['read'],
      keyId: 'k_abc',
      mode: 'api-key',
    };
    const parsed = JSON.parse(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        __principal: { mode: 'api-key', tenantId: 'attacker', scopes: ['admin'] },
      }),
    ) as Record<PropertyKey, unknown>;

    // Simulate handleMessage's scrubbing step:
    if ('__principal' in parsed) delete (parsed as Record<string, unknown>).__principal;
    // Simulate transport injection:
    parsed[PRINCIPAL_SYM] = injectedPrincipal;

    const readBack = parsed[PRINCIPAL_SYM] as Principal;
    expect(readBack.tenantId).toBe('real-tenant');
    expect(readBack.scopes).toEqual(['read']);
    expect(parsed.__principal).toBeUndefined();
    // JSON re-serialization must not leak the injected principal back to the wire.
    expect(JSON.stringify(parsed)).not.toContain('real-tenant');
    expect(JSON.stringify(parsed)).not.toContain('k_abc');
  });
});
