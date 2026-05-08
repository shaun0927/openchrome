import type { IncomingMessage } from 'node:http';
import type { Principal, Scope } from '../auth/api-key-types';
import { requestPrincipals } from './auth';

export type DashboardEndpoint = 'screenshot' | 'sessions' | 'tool-calls' | 'metrics';

export type DashboardAuthzResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; error: string };

export interface DashboardAuthzOptions {
  requestedSessionTenantId?: string;
  requireSessionOwnership?: boolean;
}

function hasScope(principal: Principal, required: Scope): boolean {
  if (principal.scopes.includes('admin')) return true;
  if (required === 'admin') return false;
  if (principal.scopes.includes('write')) return true;
  return required === 'read' && principal.scopes.includes('read');
}

function isTenantPrincipal(principal: Principal): boolean {
  return principal.mode === 'api-key' || principal.mode === 'jwt';
}

export function canSeeTenant(principal: Principal, tenantId: string | undefined): boolean {
  if (!isTenantPrincipal(principal)) return true;
  return tenantId !== undefined && tenantId === principal.tenantId;
}

export function authorizeDashboardEndpoint(
  req: IncomingMessage,
  endpoint: DashboardEndpoint,
  options: DashboardAuthzOptions = {},
): DashboardAuthzResult {
  const principal = requestPrincipals.get(req);
  if (!principal) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const requiredScope: Scope = endpoint === 'tool-calls' || endpoint === 'metrics'
    ? 'admin'
    : 'read';
  if (!hasScope(principal, requiredScope)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  if (options.requireSessionOwnership && !canSeeTenant(principal, options.requestedSessionTenantId)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  return { ok: true, principal };
}
