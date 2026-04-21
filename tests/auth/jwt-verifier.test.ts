/// <reference types="jest" />
/**
 * Tests for src/auth/jwt-verifier.ts (issue #9 / PR3).
 *
 * A local HTTP server serves a JWKS generated in-test with jose.generateKeyPair.
 * Tokens are signed with the matching private key. We exercise happy path,
 * claim/validator mismatches, scope shapes, and invalid-scope filtering.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import * as jose from 'jose';

import { createJwtVerifier } from '../../src/auth/jwt-verifier';

const ISSUER = 'https://idp.test';
const AUDIENCE = 'openchrome';

type PrivateKey = Awaited<ReturnType<typeof jose.generateKeyPair>>['privateKey'];

interface KeyMaterial {
  privateKey: PrivateKey;
  publicJwk: jose.JWK;
  kid: string;
}

async function generateKey(): Promise<KeyMaterial> {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk = await jose.exportJWK(publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = 'test-kid-1';
  return { privateKey, publicJwk, kid: 'test-kid-1' };
}

function startJwksServer(jwk: jose.JWK): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/jwks.json`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function signToken(
  privateKey: PrivateKey,
  kid: string,
  payload: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expiresIn?: string; notBefore?: string } = {},
): Promise<string> {
  let jwt = new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt();
  if (opts.issuer !== undefined) jwt = jwt.setIssuer(opts.issuer);
  if (opts.audience !== undefined) jwt = jwt.setAudience(opts.audience);
  if (opts.expiresIn !== undefined) jwt = jwt.setExpirationTime(opts.expiresIn);
  if (opts.notBefore !== undefined) jwt = jwt.setNotBefore(opts.notBefore);
  return jwt.sign(privateKey);
}

describe('createJwtVerifier', () => {
  let key: KeyMaterial;
  let jwks: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    key = await generateKey();
    jwks = await startJwksServer(key.publicJwk);
  });

  afterAll(async () => {
    await jwks.close();
  });

  test('happy path — returns Principal with tenantId + scopes', async () => {
    const verifier = createJwtVerifier({
      jwksUrl: jwks.url,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: 'read write',
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });

    const principal = await verifier.verify(token);
    expect(principal).not.toBeNull();
    expect(principal!.tenantId).toBe('acme');
    expect(principal!.scopes).toEqual(['read', 'write']);
    expect(principal!.mode).toBe('jwt');
    expect(principal!.keyId).toBe(key.kid);
  });

  test('falls back to sub when tenantClaim is missing', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      sub: 'subject-tenant',
      scope: 'read',
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).not.toBeNull();
    expect(principal!.tenantId).toBe('subject-tenant');
  });

  test('wrong issuer returns null', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: 'read',
    }, { issuer: 'https://wrong.test', audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).toBeNull();
  });

  test('wrong audience returns null', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: 'read',
    }, { issuer: ISSUER, audience: 'wrong-aud', expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).toBeNull();
  });

  test('expired token returns null', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    // jose.setExpirationTime('5m') from now; use negative seconds past epoch via raw payload.
    const token = await new jose.SignJWT({
      tenantId: 'acme',
      scope: 'read',
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key.privateKey);
    const principal = await verifier.verify(token);
    expect(principal).toBeNull();
  });

  test('missing tenantId and sub returns null', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      scope: 'read',
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).toBeNull();
  });

  test('scope as space-delimited string is parsed', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: 'read write admin',
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).not.toBeNull();
    expect(principal!.scopes).toEqual(expect.arrayContaining(['read', 'write', 'admin']));
  });

  test('scope as array is parsed', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: ['read', 'write'],
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).not.toBeNull();
    expect(principal!.scopes).toEqual(['read', 'write']);
  });

  test('invalid scope values are filtered out', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: ['read', 'super-admin', 'write', 'junk'],
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).not.toBeNull();
    expect(principal!.scopes).toEqual(['read', 'write']);
  });

  test('empty scopes after filtering returns null', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    const token = await signToken(key.privateKey, key.kid, {
      tenantId: 'acme',
      scope: ['junk', 'nope'],
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).toBeNull();
  });

  test('custom tenantClaim and scopeClaim are respected', async () => {
    const verifier = createJwtVerifier({
      jwksUrl: jwks.url,
      issuer: ISSUER,
      audience: AUDIENCE,
      tenantClaim: 'org_id',
      scopeClaim: 'permissions',
    });
    const token = await signToken(key.privateKey, key.kid, {
      org_id: 'contoso',
      permissions: 'read admin',
    }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' });
    const principal = await verifier.verify(token);
    expect(principal).not.toBeNull();
    expect(principal!.tenantId).toBe('contoso');
    expect(principal!.scopes).toEqual(expect.arrayContaining(['read', 'admin']));
  });

  test('garbage string returns null (no throw)', async () => {
    const verifier = createJwtVerifier({ jwksUrl: jwks.url, issuer: ISSUER, audience: AUDIENCE });
    await expect(verifier.verify('not-a-jwt')).resolves.toBeNull();
    await expect(verifier.verify('')).resolves.toBeNull();
  });
});
