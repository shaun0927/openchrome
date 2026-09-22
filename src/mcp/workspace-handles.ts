import { randomBytes } from 'crypto';

/**
 * Server-minted workspace handles for stateless (2026-07-28) MCP requests.
 *
 * A modern request carries no connection state, so browser state it acts on
 * must be named by an explicit identifier the server issued. A workspace
 * handle names one OpenChrome browser session, is bound to the tenant that
 * opened it, expires after an idle period, and embeds the runtime generation
 * so a handle from a replaced server process is rejected as stale instead of
 * being mistaken for an unknown or forged one.
 *
 * Handles are identifiers, not credentials: every use is still checked
 * against the caller's authenticated tenant.
 */

export const WORKSPACE_HANDLE_PREFIX = 'ocw_';
export const DEFAULT_WORKSPACE_IDLE_MS = 30 * 60_000;

export type WorkspaceErrorCode =
  | 'WORKSPACE_REQUIRED'
  | 'WORKSPACE_UNKNOWN'
  | 'WORKSPACE_EXPIRED'
  | 'WORKSPACE_FORBIDDEN'
  | 'STALE_RUNTIME';

export interface WorkspaceRecord {
  readonly handle: string;
  /** Internal OpenChrome browser session this workspace addresses. */
  readonly browserSessionId: string;
  readonly tenantId: string;
  readonly createdAt: number;
  lastUsedAt: number;
  readonly idleTtlMs: number;
}

export type WorkspaceResolution =
  | { ok: true; record: WorkspaceRecord }
  | { ok: false; code: WorkspaceErrorCode; message: string };

export function isWorkspaceHandle(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(WORKSPACE_HANDLE_PREFIX);
}

export function parseWorkspaceIdleMs(raw = process.env.OPENCHROME_WORKSPACE_IDLE_MS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_IDLE_MS;
}

export class WorkspaceHandleRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly byBrowserSession = new Map<string, WorkspaceRecord>();
  private readonly runtimeTag: string;

  constructor(
    runtimeId: string,
    private readonly options: {
      idleTtlMs?: number;
      now?: () => number;
      /**
       * Workspaces that must not expire while true, for example while a
       * person controls one of their tabs (idle time is measured from the
       * agent's last call, not the person's activity).
       */
      isProtected?: (record: WorkspaceRecord) => boolean;
    } = {},
  ) {
    this.runtimeTag = runtimeId.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  open(tenantId: string): WorkspaceRecord {
    const secret = randomBytes(18).toString('base64url');
    const record: WorkspaceRecord = {
      handle: `${WORKSPACE_HANDLE_PREFIX}${this.runtimeTag}_${secret}`,
      browserSessionId: `ws-${randomBytes(9).toString('hex')}`,
      tenantId,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      idleTtlMs: this.options.idleTtlMs ?? parseWorkspaceIdleMs(),
    };
    this.records.set(record.handle, record);
    this.byBrowserSession.set(record.browserSessionId, record);
    return record;
  }

  /**
   * Resolve a handle for the caller's tenant. Success refreshes the idle
   * deadline; failures never reveal whether a handle exists for another
   * tenant beyond the forbidden code.
   */
  resolve(handle: string, tenantId: string): WorkspaceResolution {
    const record = this.records.get(handle);
    if (!record) {
      const tag = handle.slice(WORKSPACE_HANDLE_PREFIX.length).split('_')[0];
      if (isWorkspaceHandle(handle) && tag && tag !== this.runtimeTag) {
        return {
          ok: false,
          code: 'STALE_RUNTIME',
          message: 'STALE_RUNTIME: this workspace belongs to a previous OpenChrome process; open a new workspace and re-acquire tabs. Do not replay unconfirmed actions.',
        };
      }
      return { ok: false, code: 'WORKSPACE_UNKNOWN', message: 'WORKSPACE_UNKNOWN: no such workspace; open one with oc_workspace (action "open").' };
    }
    if (record.tenantId !== tenantId) {
      return { ok: false, code: 'WORKSPACE_FORBIDDEN', message: 'WORKSPACE_FORBIDDEN: this workspace is owned by another tenant.' };
    }
    if (this.isExpired(record)) {
      this.forget(record);
      return { ok: false, code: 'WORKSPACE_EXPIRED', message: 'WORKSPACE_EXPIRED: the workspace was idle too long; open a new workspace.' };
    }
    record.lastUsedAt = this.now();
    return { ok: true, record };
  }

  /** Revoke a handle. The caller disposes of the browser session. */
  close(handle: string, tenantId: string): WorkspaceResolution {
    const resolution = this.resolve(handle, tenantId);
    if (resolution.ok) this.forget(resolution.record);
    return resolution;
  }

  list(tenantId: string): WorkspaceRecord[] {
    return [...this.records.values()].filter(record => record.tenantId === tenantId);
  }

  findByBrowserSession(browserSessionId: string): WorkspaceRecord | undefined {
    return this.byBrowserSession.get(browserSessionId);
  }

  /** Remove and return workspaces idle past their deadline. */
  sweepExpired(): WorkspaceRecord[] {
    const expired = [...this.records.values()].filter(record => this.isExpired(record));
    for (const record of expired) this.forget(record);
    return expired;
  }

  private isExpired(record: WorkspaceRecord): boolean {
    if (this.now() - record.lastUsedAt <= record.idleTtlMs) return false;
    return !(this.options.isProtected?.(record) ?? false);
  }

  clear(): void {
    this.records.clear();
    this.byBrowserSession.clear();
  }

  private forget(record: WorkspaceRecord): void {
    this.records.delete(record.handle);
    this.byBrowserSession.delete(record.browserSessionId);
  }
}
