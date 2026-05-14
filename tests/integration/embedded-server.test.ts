/**
 * Integration tests for createOpenChromeServer() programmatic API (#859).
 *
 * These tests verify the factory contract WITHOUT starting Chrome or
 * binding real transports. Heavy infrastructure (MCPServer, watchdogs,
 * CDPClient) is mocked so tests run fast and deterministically in CI.
 *
 * Contracts verified:
 *  - Singleton guard: second call before stop() throws with expected message
 *  - start() idempotency: second call returns same object reference
 *  - stop() idempotency: second call resolves without error
 *  - stop() clears the singleton so a fresh factory call succeeds (cycle test)
 *  - HTTP port:0 is resolved to a non-zero URL before start() returns
 *  - events field exposes the lifecycle bus now that A1 has landed
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import that touches singletons
// ---------------------------------------------------------------------------

// Mock the heavy infrastructure so no real Chrome / transport is started.
jest.mock('../../src/mcp-server', () => {
  const mockStop = jest.fn().mockResolvedValue(undefined);
  const mockStart = jest.fn();
  const mockHandleMessage = jest.fn().mockResolvedValue(null);
  const mockWireRateLimiterCleanup = jest.fn();
  const mockRegisterTool = jest.fn();
  const mockServer = {
    start: mockStart,
    stop: mockStop,
    handleMessage: mockHandleMessage,
    wireRateLimiterCleanup: mockWireRateLimiterCleanup,
    registerTool: mockRegisterTool,
  };
  return {
    getMCPServer: jest.fn(() => mockServer),
    setMCPServerOptions: jest.fn(),
    _resetMCPServerForTesting: jest.fn(),
  };
});

jest.mock('../../src/tools', () => ({ registerAllTools: jest.fn() }));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn(() => ({})),
  setGlobalConfig: jest.fn(),
}));

jest.mock('../../src/config/headless-resolver', () => ({
  resolveHeadlessMode: jest.fn(() => 'headed'),
}));

jest.mock('../../src/config/window-bounds', () => ({
  resolveWindowBoundsConfig: jest.fn(() => ({})),
}));

jest.mock('../../src/harness/flags', () => ({
  logActiveFlags: jest.fn(),
  bootstrapPilot: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/utils/pid-manager', () => ({
  writePidFile: jest.fn(),
  cleanOrphanedChromeProcesses: jest.fn(),
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn(() => ({ getPort: () => 9222 })),
  _resetChromeLauncherForTesting: jest.fn(),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => ({
    sessionCount: 0,
    tenantContextCount: 0,
    addEventListener: jest.fn(),
    saveAllStorageState: jest.fn().mockResolvedValue(undefined),
    getTargetOwner: jest.fn(() => null),
    getSessions: jest.fn(() => []),
  })),
  _resetSessionManagerForTesting: jest.fn(),
}));

jest.mock('../../src/chrome/pool', () => ({
  getChromePool: jest.fn(() => ({ getInstances: () => new Map() })),
  resetChromePool: jest.fn(),
}));

jest.mock('../../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    getPages: jest.fn().mockResolvedValue([]),
    getPageByTargetId: jest.fn().mockResolvedValue(null),
    getChromePid: jest.fn(() => null),
    addTargetDestroyedListener: jest.fn(),
    forceReconnect: jest.fn().mockResolvedValue(undefined),
    getConnectionMetrics: jest.fn(() => ({ reconnectCount: 0, reconnecting: false, reconnectAttempt: 0, reconnectNextRetryInMs: 0 })),
    getConnectionState: jest.fn(() => 'disconnected'),
    isConnected: jest.fn(() => false),
    disconnect: jest.fn().mockResolvedValue(undefined),
  })),
  _resetCDPClientForTesting: jest.fn(),
  _resetCDPClientFactoryForTesting: jest.fn(),
}));

jest.mock('../../src/browser-state', () => ({
  getBrowserStateManager: jest.fn(() => ({
    setCookieProvider: jest.fn(),
    setTabUrlProvider: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    getStatus: jest.fn(() => ({ lastSnapshotAt: 0, snapshotCount: 0 })),
  })),
}));

jest.mock('../../src/chrome/process-watchdog', () => ({
  ChromeProcessWatchdog: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../../src/cdp/tab-health-monitor', () => ({
  TabHealthMonitor: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    monitorTab: jest.fn(),
    unmonitorTab: jest.fn(),
    stopAll: jest.fn(),
    getAllHealth: jest.fn(() => new Map()),
  })),
}));

jest.mock('../../src/watchdog/event-loop-monitor', () => ({
  EventLoopMonitor: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    getStats: jest.fn(() => ({ maxDriftMs: 0, warnCount: 0 })),
  })),
  setGlobalEventLoopMonitor: jest.fn(),
}));

jest.mock('../../src/watchdog/health-endpoint', () => ({
  HealthEndpoint: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/utils/health-endpoint-gating', () => ({
  resolveHealthEndpointEnabled: jest.fn(() => false),
}));

jest.mock('../../src/watchdog/disk-monitor', () => ({
  DiskMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    getStats: jest.fn(() => null),
  })),
}));

jest.mock('../../src/watchdog/chrome-monitor', () => ({
  ChromeProcessMonitor: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    getStats: jest.fn(() => null),
  })),
}));

jest.mock('../../src/session-state-persistence', () => ({
  SessionStatePersistence: jest.fn().mockImplementation(() => ({
    restore: jest.fn().mockResolvedValue(null),
    scheduleSave: jest.fn(),
    cancelPendingSave: jest.fn(),
  })),
  // static method
  createSnapshot: jest.fn(() => ({})),
}));

jest.mock('../../src/utils/idle-state', () => ({
  getIdleState: jest.fn(() => ({})),
}));

jest.mock('../../src/utils/idle-timeout', () => ({
  installIdleTimeout: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../../src/utils/parent-watcher', () => ({
  installParentWatcher: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../../src/utils/safe-listener', () => ({
  getListenerErrorStats: jest.fn(() => ({ errorCount1m: 0, errorCount1h: 0 })),
}));

jest.mock('../../src/transports/index', () => ({
  createTransport: jest.fn(() => ({
    onMessage: jest.fn(),
    send: jest.fn(),
    start: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    setSessionManager: jest.fn(),
    wireRateLimiterCleanup: jest.fn(),
  })),
}));

// Mock HTTPTransport used via require() inside server.ts for http/both modes
jest.mock('../../src/transports/http', () => ({
  HTTPTransport: jest.fn().mockImplementation(() => ({
    onMessage: jest.fn(),
    send: jest.fn(),
    start: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    setSessionManager: jest.fn(),
    wireRateLimiterCleanup: jest.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { createOpenChromeServer, CreateServerOptions } from '../../src/core/server';

const STDIO_OPTS: CreateServerOptions = { transport: 'stdio' };

// Suppress process.exit calls from watchdog fatal paths
const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

afterEach(() => {
  exitSpy.mockClear();
});

afterAll(() => {
  exitSpy.mockRestore();
});

// ---------------------------------------------------------------------------
describe('createOpenChromeServer() — singleton guard', () => {
  test('second call before stop() throws with expected message', async () => {
    const server = await createOpenChromeServer(STDIO_OPTS);
    try {
      await expect(createOpenChromeServer(STDIO_OPTS)).rejects.toThrow(
        'openchrome: server already initialized — call stop() before re-creating',
      );
    } finally {
      await server.stop('caller');
    }
  });

  test('stop() resets singleton so a second createOpenChromeServer() succeeds (cycle)', async () => {
    const s1 = await createOpenChromeServer(STDIO_OPTS);
    await s1.stop('caller');

    // Must not throw
    const s2 = await createOpenChromeServer(STDIO_OPTS);
    await s2.stop('caller');
  });
});

// ---------------------------------------------------------------------------
describe('createOpenChromeServer() — start() idempotency', () => {
  test('start() called twice returns the same result object', async () => {
    const server = await createOpenChromeServer(STDIO_OPTS);
    try {
      const r1 = await server.start();
      const r2 = await server.start();
      expect(r1).toBe(r2);
    } finally {
      await server.stop('caller');
    }
  });
});

// ---------------------------------------------------------------------------
describe('createOpenChromeServer() — stop() idempotency', () => {
  test('stop() called twice resolves without error', async () => {
    const server = await createOpenChromeServer(STDIO_OPTS);
    await server.start();
    await server.stop('caller');
    await expect(server.stop('caller')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('createOpenChromeServer() — HTTP transport with port:0', () => {
  test('port:0 selects an ephemeral port and httpUrl is returned', async () => {
    const server = await createOpenChromeServer({
      transport: { http: { port: 0, host: '127.0.0.1', allowUnauthenticated: true } },
    });
    try {
      const result = await server.start();
      expect(result.httpUrl).toBeDefined();
      expect(result.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const port = parseInt(result.httpUrl!.split(':')[2], 10);
      expect(port).toBeGreaterThan(0);
    } finally {
      await server.stop('caller');
    }
  });
});

// ---------------------------------------------------------------------------
describe('createOpenChromeServer() — events field', () => {
  test('events exposes the lifecycle bus for embedded hosts', async () => {
    const server = await createOpenChromeServer(STDIO_OPTS);
    try {
      expect(server.events).toBeDefined();
      expect(typeof server.events.emit).toBe('function');
      expect(typeof server.events.on).toBe('function');
    } finally {
      await server.stop('caller');
    }
  });
});
