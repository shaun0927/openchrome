/// <reference types="jest" />
/**
 * Tests for SessionManager tenant isolation integration (#7).
 */

import type { BrowserContext } from 'puppeteer-core';

// ─── mocks ─────────────────────────────────────────────────────────────

const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  addConnectionListener: jest.fn(),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn(),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
  getBrowser: jest.fn().mockReturnValue({ targets: jest.fn().mockReturnValue([]) }),
};

jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
  getCDPClientFactory: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(mockCdpClientInstance),
    getOrCreate: jest.fn().mockReturnValue(mockCdpClientInstance),
    getAll: jest.fn().mockReturnValue([mockCdpClientInstance]),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn(),
  getCDPConnectionPool: jest.fn().mockReturnValue({}),
}));

jest.mock('../../src/utils/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_, fn) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

import { SessionManager } from '../../src/session-manager';
import { TenantManager } from '../../src/tenant/manager';
import { DEFAULT_TENANT_ID } from '../../src/tenant/types';
import { resetTenantManager } from '../../src/tenant/registry';

function stubContext(id: string): BrowserContext {
  return {
    __id: id,
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

describe('SessionManager tenant isolation (#7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTenantManager();
    delete process.env.OPENCHROME_STRICT_TENANT_ISOLATION;
    mockCdpClientInstance.createBrowserContext.mockReset();
  });

  it('preserves legacy behavior: default tenant + useDefaultContext=true yields null context', async () => {
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
    });
    const session = await sm.createSession({ id: 's1' });
    expect(session.context).toBeNull();
    expect(session.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(mockCdpClientInstance.createBrowserContext).not.toHaveBeenCalled();
  });

  it('preserves legacy behavior: default tenant + useDefaultContext=false creates anonymous context', async () => {
    const anon = stubContext('anon');
    mockCdpClientInstance.createBrowserContext.mockResolvedValue(anon);
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: false,
    });
    const session = await sm.createSession({ id: 's1' });
    expect(session.context).toBe(anon);
    expect(mockCdpClientInstance.createBrowserContext).toHaveBeenCalledTimes(1);
  });

  it('routes a non-default tenant through TenantManager and returns its context', async () => {
    let n = 0;
    const tenantCtx = stubContext('tenant');
    const tm = new TenantManager({
      createContext: jest.fn(async () => {
        n++;
        return tenantCtx;
      }),
    });
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
      tenantManager: tm,
    });

    const session = await sm.createSession({ id: 's1', tenantId: 'acme' });
    expect(session.tenantId).toBe('acme');
    expect(session.context).toBe(tenantCtx);
    expect(mockCdpClientInstance.createBrowserContext).not.toHaveBeenCalled();
    expect(n).toBe(1);
  });

  it('reuses the same tenant context across multiple sessions for the same tenant', async () => {
    const ctx = stubContext('t');
    const factory = jest.fn(async () => ctx);
    const tm = new TenantManager({ createContext: factory });
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      tenantManager: tm,
    });

    const a = await sm.createSession({ id: 's1', tenantId: 'acme' });
    const b = await sm.createSession({ id: 's2', tenantId: 'acme' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a.context).toBe(b.context);
  });

  it('isolates different tenants with distinct BrowserContexts', async () => {
    let n = 0;
    const contexts: BrowserContext[] = [];
    const factory = jest.fn(async () => {
      const ctx = stubContext(`t${++n}`);
      contexts.push(ctx);
      return ctx;
    });
    const tm = new TenantManager({ createContext: factory });
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      tenantManager: tm,
    });

    const a = await sm.createSession({ id: 's1', tenantId: 'alpha' });
    const b = await sm.createSession({ id: 's2', tenantId: 'beta' });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(a.context).not.toBe(b.context);
  });

  it('STRICT mode rejects useDefaultContext=true at session creation', async () => {
    const tm = new TenantManager({ createContext: async () => stubContext('t') });
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
      tenantManager: tm,
      strictTenantIsolation: true,
    });

    await expect(sm.createSession({ id: 's1' })).rejects.toThrow(
      /STRICT tenant isolation is enabled.*useDefaultContext=true is rejected/,
    );
  });

  it('STRICT mode assigns a tenant context even for the default tenant', async () => {
    const ctx = stubContext('def');
    const tm = new TenantManager({ createContext: async () => ctx });
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: false,
      tenantManager: tm,
      strictTenantIsolation: true,
    });

    const session = await sm.createSession({ id: 's1' });
    expect(session.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(session.context).toBe(ctx);
    expect(mockCdpClientInstance.createBrowserContext).not.toHaveBeenCalled();
  });

  it('strictTenantIsolation honors OPENCHROME_STRICT_TENANT_ISOLATION env var', async () => {
    process.env.OPENCHROME_STRICT_TENANT_ISOLATION = 'true';
    const tm = new TenantManager({ createContext: async () => stubContext('t') });
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
      tenantManager: tm,
    });
    await expect(sm.createSession({ id: 's1' })).rejects.toThrow(
      /STRICT tenant isolation is enabled/,
    );
  });

  it('getConfig does not expose DI fields', async () => {
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
    });
    const cfg = sm.getConfig() as Record<string, unknown>;
    expect(cfg.tenantManager).toBeUndefined();
    expect(cfg.strictTenantIsolation).toBeUndefined();
  });
});
