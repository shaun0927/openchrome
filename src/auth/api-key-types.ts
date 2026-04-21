// Shared types for the tenant API key store.
// Used across the auth store, HTTP middleware, and admin CLI.

export type Scope = 'read' | 'write' | 'admin' | 'headless-only';

export interface ApiKey {
  keyId: string;
  keyHash: string;
  tenantId: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  description: string;
}

export interface ApiKeyCreateInput {
  tenantId: string;
  scopes: Scope[];
  description: string;
  expiresAt?: number;
}

export interface ApiKeyCreateResult {
  record: ApiKey;
  plaintext: string;
}

// Request-scoped identity derived by the auth middleware. See src/middleware/auth.ts.
export interface Principal {
  tenantId: string;
  scopes: Scope[];
  keyId?: string;
  mode: 'disabled' | 'legacy' | 'api-key' | 'jwt';
}
