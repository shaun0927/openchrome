/**
 * Process-wide TenantManager accessor.
 *
 * Lazily constructs a singleton TenantManager whose BrowserContext factory
 * is backed by the primary CDPClient. Callers that need tenant-scoped
 * contexts (SessionManager, tool handlers) go through this registry so there
 * is a single place to configure idle timeouts and wiring.
 *
 * Tests can override the singleton via `setTenantManager(mgr)` and reset it
 * with `resetTenantManager()`.
 */

import { getCDPClient, type CDPClient } from '../cdp/client';
import {
  DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS,
  DEFAULT_STRICT_TENANT_ISOLATION,
} from '../config/defaults';
import {
  DEFAULT_TENANT_IDLE_SWEEP_INTERVAL_MS,
  TenantManager,
} from './manager';

let singleton: TenantManager | null = null;

export interface TenantRegistryOptions {
  cdpClient?: CDPClient;
  idleTimeoutMs?: number;
  idleSweepIntervalMs?: number;
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function getTenantManager(options: TenantRegistryOptions = {}): TenantManager {
  if (singleton) return singleton;
  const client = options.cdpClient ?? getCDPClient();
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    readNumberEnv('OPENCHROME_TENANT_CONTEXT_IDLE_TIMEOUT_MS') ??
    DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS;
  const idleSweepIntervalMs =
    options.idleSweepIntervalMs ??
    readNumberEnv('OPENCHROME_TENANT_IDLE_SWEEP_INTERVAL_MS') ??
    DEFAULT_TENANT_IDLE_SWEEP_INTERVAL_MS;
  singleton = new TenantManager({
    createContext: () => client.createBrowserContext(),
    config: { idleTimeoutMs },
  });
  singleton.startIdleSweep(idleSweepIntervalMs);
  return singleton;
}

/** Test-only. Replaces the singleton. Call `resetTenantManager()` to clear. */
export function setTenantManager(mgr: TenantManager | null): void {
  if (singleton && singleton !== mgr) {
    singleton.stopIdleSweep();
  }
  singleton = mgr;
}

/** Test-only. Forces the next `getTenantManager()` call to rebuild. */
export function resetTenantManager(): void {
  singleton?.stopIdleSweep();
  singleton = null;
}

/**
 * Read strict-isolation mode from env. Precedence: explicit arg > env > default.
 * When true, SessionManager rejects the "default browser context" path so a
 * session cannot share Chrome profile cookies across tenants.
 */
export function isStrictTenantIsolationEnabled(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  const raw = process.env.OPENCHROME_STRICT_TENANT_ISOLATION;
  if (raw === undefined) return DEFAULT_STRICT_TENANT_ISOLATION;
  return raw === 'true' || raw === '1';
}
