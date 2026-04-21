// JWT / OAuth verifier for the HTTP auth middleware (issue #9 / PR3).
//
// Wraps `jose.createRemoteJWKSet` + `jose.jwtVerify` and maps verified
// claims to the shared `Principal` shape. All failures (signature,
// expiry, issuer/audience mismatch, missing tenant/scopes) collapse to
// `null` so callers can treat them uniformly as 401.

import * as jose from 'jose';
import type { Principal, Scope } from './api-key-types';

const VALID_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'headless-only',
]);

export interface JwtConfig {
  jwksUrl: string;
  issuer?: string;
  audience?: string;
  tenantClaim?: string;
  scopeClaim?: string;
}

export interface JwtVerifier {
  verify(token: string): Promise<Principal | null>;
}

function parseScopes(raw: unknown): Scope[] {
  let candidates: string[] = [];
  if (typeof raw === 'string') {
    candidates = raw.split(/\s+/).filter((s) => s.length > 0);
  } else if (Array.isArray(raw)) {
    candidates = raw.filter((x): x is string => typeof x === 'string');
  } else {
    return [];
  }
  const out: Scope[] = [];
  for (const c of candidates) {
    if (VALID_SCOPES.has(c as Scope) && !out.includes(c as Scope)) {
      out.push(c as Scope);
    }
  }
  return out;
}

export function createJwtVerifier(config: JwtConfig): JwtVerifier {
  const jwks = jose.createRemoteJWKSet(new URL(config.jwksUrl));
  const tenantClaim = config.tenantClaim ?? 'tenantId';
  const scopeClaim = config.scopeClaim ?? 'scope';

  return {
    async verify(token: string): Promise<Principal | null> {
      if (typeof token !== 'string' || token.length === 0) return null;
      try {
        const { payload, protectedHeader } = await jose.jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ['RS256'],
        });

        const tenantRaw = payload[tenantClaim] ?? payload.sub;
        const tenantId = typeof tenantRaw === 'string' && tenantRaw.length > 0 ? tenantRaw : null;
        if (!tenantId) return null;

        const scopes = parseScopes(payload[scopeClaim]);
        if (scopes.length === 0) return null;

        const principal: Principal = {
          tenantId,
          scopes,
          mode: 'jwt',
        };
        if (typeof protectedHeader.kid === 'string' && protectedHeader.kid.length > 0) {
          principal.keyId = protectedHeader.kid;
        }
        return principal;
      } catch {
        // Intentionally swallow — never log raw token.
        return null;
      }
    },
  };
}
