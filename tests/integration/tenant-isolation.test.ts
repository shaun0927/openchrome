/// <reference types="jest" />
/**
 * Cross-tenant BrowserContext isolation — integration-style tests (#7).
 *
 * Exercises TenantManager + SessionManager together with stubbed CDP so
 * we can assert distinct tenants never share a BrowserContext, and that
 * the same tenant reuses its context across sessions and Chrome
 * reconnects.
 */

import type { BrowserContext } from 'puppeteer-core';

// ─── mocks ─────────────────────────────────────────────────────────────

let contextCounter = 0;
function makeStubContext(): BrowserContext {
  const id = `ctx-${++contextCounter}`;
  return {
    __id: id,
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  addConnectionListener: jest.fn(),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn().mockImplementation(async () => makeStubContext()),
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

describe('Cross-tenant BrowserContext isolation (#7)', () => {
  let tenantManager: TenantManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    contextCounter = 0;
    resetTenantManager();
    delete process.env.OPENCHROME_STRICT_TENANT_ISOLATION;

    tenantManager = new TenantManager({
      createContext: () => mockCdpClientInstance.createBrowserContext(),
    });
    sessionManager = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: false,
      tenantManager,
    });
  });

  it('sessions in different tenants receive distinct BrowserContexts', async () => {
    const acme1 = await sessionManager.createSession({ id: 'a1', tenantId: 'acme' });
    const initech1 = await sessionManager.createSession({ id: 'i1', tenantId: 'initech' });
    expect(acme1.context).not.toBe(initech1.context);
    expect(acme1.tenantId).toBe('acme');
    expect(initech1.tenantId).toBe('initech');
  });

  it('sessions in the same tenant share the same BrowserContext', async () => {
    const a = await sessionManager.createSession({ id: 'a', tenantId: 'acme' });
    const b = await sessionManager.createSession({ id: 'b', tenantId: 'acme' });
    expect(a.context).toBe(b.context);
  });

  it('many tenants get many distinct contexts (linear growth)', async () => {
    const count = 8;
    const contexts = new Set<BrowserContext | null | undefined>();
    for (let i = 0; i < count; i++) {
      const s = await sessionManager.createSession({
        id: `s-${i}`,
        tenantId: `tenant-${i}`,
      });
      contexts.add(s.context);
    }
    expect(contexts.size).toBe(count);
    expect(tenantManager.stats().active).toBe(count);
  });

  it('releasing one tenant does not disturb others', async () => {
    await sessionManager.createSession({ id: 'a', tenantId: 'alpha' });
    await sessionManager.createSession({ id: 'b', tenantId: 'beta' });
    expect(tenantManager.stats().active).toBe(2);

    const released = await tenantManager.release('alpha');
    expect(released).toBe(true);
    expect(tenantManager.has('alpha')).toBe(false);
    expect(tenantManager.has('beta')).toBe(true);
    expect(tenantManager.stats().active).toBe(1);
  });

  it('STRICT mode assigns a tenant context to the default tenant too', async () => {
    const strictMgr = new TenantManager({
      createContext: () => mockCdpClientInstance.createBrowserContext(),
    });
    const strictSm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: false,
      tenantManager: strictMgr,
      strictTenantIsolation: true,
    });
    const s = await strictSm.createSession({ id: 's' });
    expect(s.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(s.context).not.toBeNull();
    expect(strictMgr.has(DEFAULT_TENANT_ID)).toBe(true);
  });

  it('closeAll() closes every tenant context cleanly', async () => {
    await sessionManager.createSession({ id: 's1', tenantId: 'alpha' });
    await sessionManager.createSession({ id: 's2', tenantId: 'beta' });
    const contexts = tenantManager.list().map((t) => t.browserContext);
    await tenantManager.closeAll();
    expect(tenantManager.stats().active).toBe(0);
    for (const ctx of contexts) {
      expect((ctx as unknown as { close: jest.Mock }).close).toHaveBeenCalled();
    }
  });
});
