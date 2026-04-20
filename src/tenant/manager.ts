/**
 * TenantManager — owns per-tenant Puppeteer BrowserContexts.
 *
 * Each tenant gets an isolated BrowserContext so cookies / localStorage /
 * IndexedDB / service worker caches do not bleed across tenants. The manager
 * is created with a BrowserContext factory (so it is testable without a real
 * Chrome) and an optional closer. Integration with SessionManager happens in
 * a later change — this module is standalone.
 */

import type { BrowserContext } from 'puppeteer-core';
import {
  DEFAULT_TENANT_ID,
  TenantContext,
  TenantId,
  TenantManagerConfig,
  TenantManagerStats,
} from './types';

/** Creates a fresh isolated BrowserContext. Supplied by the host (e.g. CDPClient). */
export type BrowserContextFactory = () => Promise<BrowserContext>;

/** Closes a BrowserContext. Defaults to calling `close()` on the context itself. */
export type BrowserContextCloser = (ctx: BrowserContext) => Promise<void>;

/** Default idle timeout (10 minutes) before a tenant context is garbage collected. */
export const DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Default tenant concurrency cap. Conservative; tune per deployment. */
export const DEFAULT_MAX_TENANTS = 500;

/** Default periodic sweep interval (1 minute) for the idle GC timer. */
export const DEFAULT_TENANT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

const defaultCloser: BrowserContextCloser = async (ctx) => {
  await ctx.close();
};

export interface TenantManagerDeps {
  createContext: BrowserContextFactory;
  closeContext?: BrowserContextCloser;
  now?: () => number;
  config?: TenantManagerConfig;
}

export class TenantManager {
  private readonly tenants = new Map<TenantId, TenantContext>();
  private readonly createContext: BrowserContextFactory;
  private readonly closeContext: BrowserContextCloser;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly maxTenants: number;
  private totalCreated = 0;
  private totalClosed = 0;
  private idleEvictions = 0;
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TenantManagerDeps) {
    this.createContext = deps.createContext;
    this.closeContext = deps.closeContext ?? defaultCloser;
    this.now = deps.now ?? (() => Date.now());
    this.idleTimeoutMs =
      deps.config?.idleTimeoutMs ?? DEFAULT_TENANT_CONTEXT_IDLE_TIMEOUT_MS;
    this.maxTenants = deps.config?.maxTenants ?? DEFAULT_MAX_TENANTS;
  }

  /** Lazily create (or return existing) tenant context. Updates lastActivityAt. */
  async getOrCreate(id: TenantId): Promise<TenantContext> {
    const existing = this.tenants.get(id);
    if (existing) {
      existing.lastActivityAt = this.now();
      return existing;
    }
    if (this.tenants.size >= this.maxTenants) {
      throw new Error(
        `TenantManager: max tenants reached (${this.maxTenants}). Active: ${this.tenants.size}`,
      );
    }
    const browserContext = await this.createContext();
    const ts = this.now();
    const entry: TenantContext = {
      id,
      browserContext,
      createdAt: ts,
      lastActivityAt: ts,
    };
    this.tenants.set(id, entry);
    this.totalCreated++;
    return entry;
  }

  /** Mark a tenant as recently used without creating it. No-op if missing. */
  touch(id: TenantId): void {
    const entry = this.tenants.get(id);
    if (entry) {
      entry.lastActivityAt = this.now();
    }
  }

  has(id: TenantId): boolean {
    return this.tenants.has(id);
  }

  get(id: TenantId): TenantContext | undefined {
    return this.tenants.get(id);
  }

  list(): TenantContext[] {
    return Array.from(this.tenants.values());
  }

  /** Close a single tenant context and remove it. Returns true if removed. */
  async release(id: TenantId): Promise<boolean> {
    const entry = this.tenants.get(id);
    if (!entry) return false;
    this.tenants.delete(id);
    try {
      await this.closeContext(entry.browserContext);
    } catch (err) {
      console.error(
        `[TenantManager] Failed to close context for tenant=${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    this.totalClosed++;
    return true;
  }

  /** Close every tenant context. Safe to call on shutdown / Chrome reconnect. */
  async closeAll(): Promise<void> {
    const ids = Array.from(this.tenants.keys());
    await Promise.all(ids.map((id) => this.release(id)));
  }

  /**
   * Evict tenant contexts idle beyond the configured timeout. Returns the IDs
   * removed. Callers may invoke this on a timer or after session close events.
   * The `default` tenant is never evicted automatically to preserve stdio
   * single-user compatibility.
   */
  async sweepIdle(nowOverride?: number): Promise<TenantId[]> {
    const cutoff = (nowOverride ?? this.now()) - this.idleTimeoutMs;
    const victims: TenantId[] = [];
    for (const entry of this.tenants.values()) {
      if (entry.id === DEFAULT_TENANT_ID) continue;
      if (entry.lastActivityAt <= cutoff) {
        victims.push(entry.id);
      }
    }
    for (const id of victims) {
      const removed = await this.release(id);
      if (removed) this.idleEvictions++;
    }
    return victims;
  }

  stats(): TenantManagerStats {
    return {
      active: this.tenants.size,
      totalCreated: this.totalCreated,
      totalClosed: this.totalClosed,
      idleEvictions: this.idleEvictions,
    };
  }

  /**
   * Start a periodic background timer that calls `sweepIdle()` every
   * `intervalMs`. Safe to call multiple times — a second call replaces the
   * existing timer. The timer is `unref()`ed so it does not keep a Node
   * process alive on its own.
   */
  startIdleSweep(intervalMs = DEFAULT_TENANT_IDLE_SWEEP_INTERVAL_MS): void {
    this.stopIdleSweep();
    this.idleSweepTimer = setInterval(() => {
      this.sweepIdle().catch((err) => {
        console.error(
          '[TenantManager] idle sweep failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }, intervalMs);
    this.idleSweepTimer.unref?.();
  }

  /** Stop the periodic idle sweep timer started by `startIdleSweep()`. */
  stopIdleSweep(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
  }
}
