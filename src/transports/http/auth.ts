import type { ApiKeyStore } from '../../auth/api-key-store';
import type { JwtVerifier } from '../../auth/jwt-verifier';
import type { AuthMode } from '../../middleware/auth';

export function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * Resolve the runtime auth mode from env + ctor args.
 * Precedence:
 *   1. Explicit env OPENCHROME_AUTH_MODE=legacy-shared-token -> legacy
 *      (fail-closed: throws if no token is configured; setting this env is
 *      an explicit operator request to enforce auth, so we must not silently
 *      downgrade to `disabled` on a wiring/secret-injection failure).
 *   2. store && jwt -> api-key-or-jwt
 *   3. ApiKeyStore provided -> api-key
 *   4. jwt provided -> jwt
 *   5. authToken provided (backwards compat) -> legacy
 *   6. Nothing configured -> disabled
 */
export function resolveAuthMode(
  authToken: string | undefined,
  store: ApiKeyStore | undefined,
  verifier?: JwtVerifier,
): AuthMode {
  const envMode = process.env.OPENCHROME_AUTH_MODE;
  if (envMode === 'legacy-shared-token') {
    if (!authToken) {
      throw new Error(
        'OPENCHROME_AUTH_MODE=legacy-shared-token requires a shared token ' +
          '(set OPENCHROME_AUTH_TOKEN or pass authToken to HTTPTransport). ' +
          'Refusing to start with the env flag set but no token configured — ' +
          'silently falling back to unauthenticated mode would be a security regression.',
      );
    }
    return { kind: 'legacy-shared-token', token: authToken };
  }
  if (store && verifier) {
    return { kind: 'api-key-or-jwt', store, verifier };
  }
  if (store) {
    return { kind: 'api-key', store };
  }
  if (verifier) {
    return { kind: 'jwt', verifier };
  }
  if (authToken) {
    return { kind: 'legacy-shared-token', token: authToken };
  }
  return { kind: 'disabled' };
}

export function validateUnauthenticatedHttpPolicy(
  authMode: AuthMode,
  host: string,
  allowUnauthenticatedHttp: boolean,
): void {
  if (authMode.kind !== 'disabled') return;

  const migration = 'Configure HTTP auth (OPENCHROME_AUTH_TOKEN, API keys, or JWT), use stdio, ' +
    'or set OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP=1 for loopback-only development.';
  if (!allowUnauthenticatedHttp) {
    throw new Error(`Refusing to start unauthenticated HTTP transport. ${migration}`);
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Refusing to start unauthenticated HTTP transport on non-loopback host ${host}. ${migration}`,
    );
  }
}
