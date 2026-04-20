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

export type { Principal };

export type AuthMode =
  | { kind: 'disabled' }
  | { kind: 'legacy-shared-token'; token: string }
  | { kind: 'api-key'; store: ApiKeyStore };

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
  // Mirrors the derivation in ApiKeyStore so audit logs on failure can
  // reference the same opaque id the store would have assigned.
  const digest = crypto.createHash('sha256').update(plaintext).digest();
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let num = 0n;
  for (const byte of digest) num = (num << 8n) | BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 62n)] + out;
    num = num / 62n;
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

  // mode.kind === 'api-key'
  if (!token.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  const attemptKeyId = computeKeyIdFromPlaintext(token);
  const record = await mode.store.verify(token);
  if (!record) {
    return { ok: false, status: 401, error: 'Unauthorized', keyId: attemptKeyId };
  }
  // Fire-and-forget lastUsedAt update; failures must not block the request.
  mode.store.touchLastUsed(record.keyId).catch((err) => {
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
