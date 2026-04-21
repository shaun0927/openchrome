// Pluggable auth middleware for the HTTP transport (issue #9 / PR2).
//
// Resolves a request to a Principal according to the configured AuthMode.
// Callers (the HTTP transport) receive either `{ ok: true, principal }` or
// a structured failure `{ ok: false, status, error, keyId? }` — the keyId
// on failure is the sha256-derived id of the *attempted* plaintext so audit
// logs can reference the attempt without ever storing the plaintext itself.

import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ApiKeyStore } from '../auth/api-key-store';
import type { Principal, Scope } from '../auth/api-key-types';
import type { JwtVerifier } from '../auth/jwt-verifier';

export type { Principal };

/**
 * Non-forgeable key used by the transport layer to attach a trusted Principal
 * to a parsed JSON-RPC message before it reaches the MCP server core.
 *
 * Why a Symbol: `JSON.parse` can never produce symbol-keyed properties, so
 * clients cannot inject this field through the wire payload. A string key
 * like `__principal` would be forgeable by any caller that controls the
 * JSON body (notably stdio callers, whose transport does not inject a
 * principal at all). Using a symbol here eliminates the trust boundary
 * question entirely — if `msg[PRINCIPAL_SYM]` is present, the transport
 * set it.
 */
export const PRINCIPAL_SYM: unique symbol = Symbol('mcp.auth.principal');

export type AuthMode =
  | { kind: 'disabled' }
  | { kind: 'legacy-shared-token'; token: string }
  | { kind: 'api-key'; store: ApiKeyStore }
  | { kind: 'jwt'; verifier: JwtVerifier }
  | { kind: 'api-key-or-jwt'; store: ApiKeyStore; verifier: JwtVerifier };

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string; keyId?: string };

// Per-request principal storage. The HTTP transport stashes the principal
// under the IncomingMessage key so downstream handlers can retrieve it
// without passing it through every call site.
export const requestPrincipals: WeakMap<IncomingMessage, Principal> = new WeakMap();

const KEY_PREFIX = 'oc_live_';

function extractBearer(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  if (!raw || typeof raw !== 'string') return null;
  if (!raw.startsWith('Bearer ')) return null;
  return raw.slice(7);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function computeKeyIdFromPlaintext(plaintext: string): string {
  // Mirrors the derivation in ApiKeyStore.base62Encode exactly — including
  // the fixed-length left-padding — so audit logs on failure reference the
  // same opaque id the store would have assigned. Without the pad, digests
  // starting with zero bytes produced a shorter bigint string and a keyId
  // that disagreed with the stored record, breaking correlation.
  const digest = crypto.createHash('sha256').update(plaintext).digest();
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let num = 0n;
  for (const byte of digest) num = (num << 8n) | BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 62n)] + out;
    num = num / 62n;
  }
  const targetLen = Math.ceil((digest.length * Math.log(256)) / Math.log(62));
  if (out.length < targetLen) {
    out = ALPHABET[0].repeat(targetLen - out.length) + out;
  }
  return 'k_' + out.slice(0, 10);
}

export async function authenticate(
  req: IncomingMessage,
  mode: AuthMode,
): Promise<AuthResult> {
  if (mode.kind === 'disabled') {
    return {
      ok: true,
      principal: {
        tenantId: 'anonymous',
        scopes: ['admin'] as Scope[],
        mode: 'disabled',
      },
    };
  }

  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  if (mode.kind === 'legacy-shared-token') {
    if (!timingSafeStringEqual(token, mode.token)) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    return {
      ok: true,
      principal: {
        tenantId: 'legacy',
        scopes: ['admin'] as Scope[],
        mode: 'legacy',
      },
    };
  }

  if (mode.kind === 'api-key') {
    return authenticateApiKey(token, mode.store);
  }

  if (mode.kind === 'jwt') {
    return authenticateJwt(token, mode.verifier);
  }

  // mode.kind === 'api-key-or-jwt' — route by prefix.
  if (token.startsWith(KEY_PREFIX)) {
    return authenticateApiKey(token, mode.store);
  }
  return authenticateJwt(token, mode.verifier);
}

async function authenticateApiKey(token: string, store: ApiKeyStore): Promise<AuthResult> {
  if (!token.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  const attemptKeyId = computeKeyIdFromPlaintext(token);
  const record = await store.verify(token);
  if (!record) {
    return { ok: false, status: 401, error: 'Unauthorized', keyId: attemptKeyId };
  }
  // Fire-and-forget lastUsedAt update; failures must not block the request.
  store.touchLastUsed(record.keyId).catch((err) => {
    console.error('[auth] touchLastUsed failed:', err);
  });
  return {
    ok: true,
    principal: {
      tenantId: record.tenantId,
      scopes: [...record.scopes],
      keyId: record.keyId,
      mode: 'api-key',
    },
  };
}

async function authenticateJwt(token: string, verifier: JwtVerifier): Promise<AuthResult> {
  const principal = await verifier.verify(token);
  if (!principal) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true, principal };
}
