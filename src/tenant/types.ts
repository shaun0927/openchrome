/**
 * Tenant isolation types.
 *
 * A tenant owns an isolated Puppeteer BrowserContext so its cookies,
 * localStorage, IndexedDB, and service worker caches are scoped away
 * from other tenants. See docs/roadmap and GitHub issue #7 for context.
 */

import type { BrowserContext } from 'puppeteer-core';

export type TenantId = string;

/** Reserved tenant used when no tenant identifier is supplied (stdio / single-user mode). */
export const DEFAULT_TENANT_ID: TenantId = 'default';

export interface TenantContext {
  id: TenantId;
  browserContext: BrowserContext;
  createdAt: number;
  lastActivityAt: number;
}

export interface TenantManagerStats {
  active: number;
  totalCreated: number;
  totalClosed: number;
  idleEvictions: number;
}

export interface TenantManagerConfig {
  /** Idle timeout in ms before a tenant context is eligible for garbage collection. */
  idleTimeoutMs?: number;
  /** Maximum concurrent tenant contexts. Creation beyond this throws. */
  maxTenants?: number;
}
