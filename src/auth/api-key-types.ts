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
