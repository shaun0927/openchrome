/// <reference types="jest" />
// Tests for src/middleware/auth.ts — PR2 (issue #9)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { ApiKeyStore } from '../../src/auth/api-key-store';
import { authenticate, type AuthMode } from '../../src/middleware/auth';
import type { JwtVerifier } from '../../src/auth/jwt-verifier';
import type { Principal } from '../../src/auth/api-key-types';

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  Object.assign(req.headers, headers);
  return req;
}

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auth-test-'));
  return path.join(dir, 'api-keys.jsonl');
}

// ─── disabled mode ────────────────────────────────────────────────────────────

describe('disabled mode', () => {
  const mode: AuthMode = { kind: 'disabled' };

  it('returns ok=true with admin scopes and no Bearer header', async () => {
    const result = await authenticate(makeReq(), mode);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.mode).toBe('disabled');
    expect(result.principal.scopes).toContain('admin');
    expect(result.principal.tenantId).toBe('anonymous');
  });
});

// ─── legacy-shared-token mode ─────────────────────────────────────────────────

describe('legacy-shared-token mode', () => {
  const TOKEN = 'super-secret-token-xyz';
  const mode: AuthMode = { kind: 'legacy-shared-token', token: TOKEN };

  it('happy path — correct bearer returns legacy principal', async () => {
    const req = makeReq({ authorization: `Bearer ${TOKEN}` });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.mode).toBe('legacy');
    expect(result.principal.tenantId).toBe('legacy');
    expect(result.principal.scopes).toContain('admin');
    expect(result.principal.keyId).toBeUndefined();
  });

  it('wrong token returns 401', async () => {
    const req = makeReq({ authorization: 'Bearer wrong-token' });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it('missing Authorization header returns 401', async () => {
    const result = await authenticate(makeReq(), mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });
});

// ─── api-key mode ─────────────────────────────────────────────────────────────

describe('api-key mode', () => {
  let store: ApiKeyStore;
  let mode: AuthMode;

  beforeEach(async () => {
    store = await ApiKeyStore.open(tmpStore());
    mode = { kind: 'api-key', store };
  });

  it('happy path — correct key returns principal with tenantId + scopes', async () => {
    const { plaintext, record } = await store.create({
      tenantId: 'acme',
      scopes: ['read', 'write'],
      description: 'test key',
    });
    const req = makeReq({ authorization: `Bearer ${plaintext}` });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.tenantId).toBe('acme');
    expect(result.principal.scopes).toEqual(expect.arrayContaining(['read', 'write']));
    expect(result.principal.keyId).toBe(record.keyId);
    expect(result.principal.mode).toBe('api-key');
  }, 20000);

  it('wrong key returns 401 with a keyId in the failure result', async () => {
    await store.create({ tenantId: 'acme', scopes: ['read'], description: '' });
    // Construct a syntactically valid but wrong plaintext
    const fakeKey = 'oc_live_acme_' + 'X'.repeat(32);
    const req = makeReq({ authorization: `Bearer ${fakeKey}` });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.keyId).toMatch(/^k_/);
  }, 20000);

  it('successful auth produces the same keyId as the store (base62 padding parity)', async () => {
    // Regression guard for Codex P2: middleware's computeKeyIdFromPlaintext
    // omitted the base62 left-pad used by ApiKeyStore. Any drift re-surfaces
    // as the middleware's attempt-keyId disagreeing with record.keyId.
    const samples = 12;
    for (let i = 0; i < samples; i++) {
      const { plaintext, record } = await store.create({
        tenantId: `t-${i}`,
        scopes: ['read'],
        description: '',
      });
      const req = makeReq({ authorization: `Bearer ${plaintext}` });
      const result = await authenticate(req, mode);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.principal.keyId).toBe(record.keyId);
    }
  }, 60000);

  it('revoked key returns 401', async () => {
    const { plaintext, record } = await store.create({
      tenantId: 't1',
      scopes: ['read'],
      description: '',
    });
    await store.revoke(record.keyId);
    const req = makeReq({ authorization: `Bearer ${plaintext}` });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  }, 20000);

  it('expired key returns 401', async () => {
    const { plaintext } = await store.create({
      tenantId: 't2',
      scopes: ['read'],
      description: '',
      expiresAt: Date.now() - 1000, // already expired
    });
    const req = makeReq({ authorization: `Bearer ${plaintext}` });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  }, 20000);

  it('sets lastUsedAt via touchLastUsed (fire-and-forget)', async () => {
    const { plaintext, record } = await store.create({
      tenantId: 'touch-test',
      scopes: ['read'],
      description: '',
    });
    const before = Date.now();
    const req = makeReq({ authorization: `Bearer ${plaintext}` });
    await authenticate(req, mode);
    // touchLastUsed is fire-and-forget from the middleware. It needs to acquire
    // the file lock and append — poll until the value appears (max 5s).
    let key: Awaited<ReturnType<typeof store.list>>[number] | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const keys = await store.list();
      key = keys.find((k) => k.keyId === record.keyId);
      if (key?.lastUsedAt !== undefined) break;
    }
    expect(key?.lastUsedAt).toBeGreaterThanOrEqual(before);
  }, 20000);
});

// ─── jwt mode ────────────────────────────────────────────────────────────────

function stubVerifier(principal: Principal | null): JwtVerifier {
  return {
    verify: async () => (principal ? { ...principal, scopes: [...principal.scopes] } : null),
  };
}

describe('jwt mode', () => {
  it('happy path — verifier returns principal, middleware wraps as ok', async () => {
    const verifier = stubVerifier({
      tenantId: 'acme',
      scopes: ['read', 'write'],
      mode: 'jwt',
      keyId: 'kid-abc',
    });
    const mode: AuthMode = { kind: 'jwt', verifier };
    const req = makeReq({ authorization: 'Bearer header.payload.sig' });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.tenantId).toBe('acme');
    expect(result.principal.mode).toBe('jwt');
    expect(result.principal.scopes).toEqual(['read', 'write']);
    expect(result.principal.keyId).toBe('kid-abc');
  });

  it('verifier returning null yields 401', async () => {
    const verifier = stubVerifier(null);
    const mode: AuthMode = { kind: 'jwt', verifier };
    const req = makeReq({ authorization: 'Bearer bad.token' });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });
});

// ─── api-key-or-jwt mode ─────────────────────────────────────────────────────

describe('api-key-or-jwt mode', () => {
  let store: ApiKeyStore;

  beforeEach(async () => {
    store = await ApiKeyStore.open(tmpStore());
  });

  it('routes oc_live_* tokens through the api-key store', async () => {
    const verifier = stubVerifier(null); // would fail if asked
    const { plaintext, record } = await store.create({
      tenantId: 'acme',
      scopes: ['read'],
      description: '',
    });
    const mode: AuthMode = { kind: 'api-key-or-jwt', store, verifier };
    const req = makeReq({ authorization: `Bearer ${plaintext}` });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.mode).toBe('api-key');
    expect(result.principal.keyId).toBe(record.keyId);
  }, 20000);

  it('routes non-prefix tokens through the jwt verifier', async () => {
    const verifier = stubVerifier({
      tenantId: 'jwt-tenant',
      scopes: ['read'],
      mode: 'jwt',
    });
    const mode: AuthMode = { kind: 'api-key-or-jwt', store, verifier };
    const req = makeReq({ authorization: 'Bearer eyJ.looks.likeajwt' });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.mode).toBe('jwt');
    expect(result.principal.tenantId).toBe('jwt-tenant');
  });

  it('jwt path returning null yields 401', async () => {
    const verifier = stubVerifier(null);
    const mode: AuthMode = { kind: 'api-key-or-jwt', store, verifier };
    const req = makeReq({ authorization: 'Bearer nope.nope.nope' });
    const result = await authenticate(req, mode);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });
});
