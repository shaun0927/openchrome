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
  // In-flight creations keyed by tenant id. Concurrent getOrCreate calls for
  // the same tenant share a single promise so only one BrowserContext is
  // created, and the cap accounting below counts pending slots as occupied.
  private readonly pending = new Map<TenantId, Promise<TenantContext>>();
  private readonly createContext: BrowserContextFactory;
  private readonly closeContext: BrowserContextCloser;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly maxTenants: number;
  private totalCreated = 0;
  private totalClosed = 0;
  private idleEvictions = 0;
  // Holds the in-flight `closeAll` promise while a close is running. Serves
  // as a single-flight lock so concurrent `closeAll()` calls share the same
  // drain, and so `getOrCreate` can reject for the full duration (not until
  // the first caller's finally runs). Cleared after the drain so the manager
  // is reusable (e.g. after a Chrome reconnect).
  private closingPromise: Promise<void> | null = null;

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
    if (this.closingPromise !== null) {
      throw new Error(
        `TenantManager: closeAll in progress, refusing to create tenant=${id}`,
      );
    }
    const existing = this.tenants.get(id);
    if (existing) {
      existing.lastActivityAt = this.now();
      return existing;
    }
    const inFlight = this.pending.get(id);
    if (inFlight) {
      return inFlight;
    }
    if (this.tenants.size + this.pending.size >= this.maxTenants) {
      throw new Error(
        `TenantManager: max tenants reached (${this.maxTenants}). Active: ${this.tenants.size}, pending: ${this.pending.size}`,
      );
    }
    const creation = (async (): Promise<TenantContext> => {
      // Yield once so `this.pending.set(id, creation)` below executes before
      // any factory code runs. Without this, a factory that throws
      // synchronously (not via a rejected promise) would reach the `finally`
      // block *before* the pending slot is installed — the delete would be a
      // no-op and the rejected promise would be stored permanently, pinning
      // the id and consuming maxTenants capacity forever.
      await Promise.resolve();
      try {
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
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, creation);
    return creation;
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

  /**
   * Close a single tenant context and remove it. Returns true if removed.
   *
   * If the tenant is still being created (entry is in `pending`), waits for
   * the creation to finish before releasing — otherwise the in-flight
   * creation would land in `this.tenants` after release returned, leaving an
   * orphaned BrowserContext.
   */
  async release(id: TenantId): Promise<boolean> {
    const inFlight = this.pending.get(id);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // createContext failed — nothing to release, `finally` in
        // getOrCreate already cleared the pending slot.
        return false;
      }
    }
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

  /**
   * Close every tenant context. Safe to call on shutdown / Chrome reconnect.
   *
   * Single-flight: concurrent callers share the in-flight drain via
   * `closingPromise` so the "no new tenants" window lasts for the full
   * duration of the slowest caller, not just until the first one returns.
   * Drains in-flight creations first so their resulting contexts land in
   * `this.tenants` and can be released — otherwise a creation mid-await when
   * closeAll starts would insert after we snapshot the map and leak a live
   * BrowserContext. The lock is released after the drain so the manager is
   * reusable (e.g. after a Chrome reconnect). Pending rejections from failed
   * creations are intentionally ignored (nothing to close).
   */
  closeAll(): Promise<void> {
    if (this.closingPromise !== null) {
      return this.closingPromise;
    }
    // Not `async`: we want `closeAll() === closeAll()` during the window so
    // concurrent callers truly share one promise (an `async` wrapper would
    // hand out a distinct resolver-chain promise per call).
    this.closingPromise = (async () => {
      try {
        if (this.pending.size > 0) {
          await Promise.allSettled(Array.from(this.pending.values()));
        }
        const ids = Array.from(this.tenants.keys());
        await Promise.all(ids.map((id) => this.release(id)));
      } finally {
        this.closingPromise = null;
      }
    })();
    return this.closingPromise;
  }

  /**
   * Evict tenant contexts idle beyond the configured timeout. Returns the IDs
   * removed. Callers may invoke this on a timer or after session close events.
   * The `default` tenant is never evicted automatically to preserve stdio
   * single-user compatibility.
   */
  async sweepIdle(nowOverride?: number): Promise<TenantId[]> {
    const cutoff = (nowOverride ?? this.now()) - this.idleTimeoutMs;
    const candidates: TenantId[] = [];
    for (const entry of this.tenants.values()) {
      if (entry.id === DEFAULT_TENANT_ID) continue;
      if (entry.lastActivityAt <= cutoff) {
        candidates.push(entry.id);
      }
    }
    // Re-check each candidate at release time. Concurrent `touch` /
    // `getOrCreate` calls on a candidate between iterations update
    // `lastActivityAt`; evicting on the stale snapshot would kill a tenant
    // that is actively being used.
    const evicted: TenantId[] = [];
    for (const id of candidates) {
      const entry = this.tenants.get(id);
      if (!entry) continue;
      if (entry.lastActivityAt > cutoff) continue;
      const removed = await this.release(id);
      if (removed) {
        this.idleEvictions++;
        evicted.push(id);
      }
    }
    return evicted;
  }

  stats(): TenantManagerStats {
    return {
      active: this.tenants.size,
      totalCreated: this.totalCreated,
      totalClosed: this.totalClosed,
      idleEvictions: this.idleEvictions,
    };
  }
}
