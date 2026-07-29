import type { Principal } from './api-key-types';

export function isTenantScopedPrincipal(
  principal: Principal | undefined,
): principal is Principal & { mode: 'api-key' | 'jwt' } {
  return principal?.mode === 'api-key' || principal?.mode === 'jwt';
}

export function resolveEffectiveTenantId(
  principal: Principal | undefined,
  requestTenantId: string | undefined,
): string | undefined {
  if (isTenantScopedPrincipal(principal)) {
    return principal.tenantId;
  }
  return requestTenantId ?? principal?.tenantId;
}
