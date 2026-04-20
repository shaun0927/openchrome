/// <reference types="jest" />
/**
 * Budget-driven connectInternal retry loop (A-3, PR 2/3).
 *
 * Verifies that when a Budget is supplied, connectInternal:
 *  - fails within the budget window (rather than 45s fixed retry × 15s)
 *  - throws SessionInitBudgetExhausted (not a generic timeout Error)
 *  - still falls through the fixed-retry path when no budget is supplied
 */

// ─── Mocks (must precede imports) ─────────────────────────────────────────────

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

const mockEnsureChrome = jest.fn();
const mockInvalidateInstance = jest.fn();
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: mockEnsureChrome,
    invalidateInstance: mockInvalidateInstance,
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

// Keep per-attempt timeout small so non-budget path doesn't dominate wall-clock.
jest.mock('../../src/config/defaults', () => {
  const actual = jest.requireActual('../../src/config/defaults');
  return {
    ...actual,
    DEFAULT_PUPPETEER_CONNECT_TIMEOUT_MS: 200,
    DEFAULT_SESSION_INIT_MIN_ATTEMPT_MS: 100,
  };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CDPClient } from '../../src/cdp/client';
import { createBudget } from '../../src/utils/budget';
import { SessionInitBudgetExhausted } from '../../src/cdp/errors';

const puppeteerMock = jest.requireMock('puppeteer-core') as { default: { connect: jest.Mock } };
const mockPuppeteerConnect = puppeteerMock.default.connect;

function stopHeartbeat(client: CDPClient) {
  const hb = (client as any).heartbeatTimer;
  if (hb) {
    clearInterval(hb);
    (client as any).heartbeatTimer = null;
  }
}

describe('connectInternal — budget-driven retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureChrome.mockResolvedValue({
      wsEndpoint: 'ws://localhost:9222/devtools/browser/abc',
      pid: 12345,
    });
    delete process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE;
  });

  afterEach(() => {
    delete process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE;
  });

  test('exits within budget window when puppeteer.connect never resolves', async () => {
    // puppeteer.connect hangs forever -> per-attempt WS timeout fires repeatedly
    mockPuppeteerConnect.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const client = new CDPClient({ port: 9222, autoLaunch: false });
    const budget = createBudget(1000, 'session-init');
    const start = Date.now();
    let caught: unknown;
    try {
      await (client as any).connectInternal({ autoLaunch: false, budget });
    } catch (err) {
      caught = err;
    } finally {
      stopHeartbeat(client);
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(SessionInitBudgetExhausted);
    const e = caught as SessionInitBudgetExhausted;
    expect(e.stage).toBe('session-init');
    // Must finish close to the 1000ms budget — allow 1s slack for scheduling/teardown.
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  test('legacy mode env flag keeps fixed-retry behavior', async () => {
    process.env.OPENCHROME_SESSION_INIT_BUDGET_MODE = 'legacy';
    mockPuppeteerConnect.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const client = new CDPClient({ port: 9222, autoLaunch: false });
    const budget = createBudget(200, 'session-init');

    let caught: unknown;
    try {
      // Even though we pass a budget, legacy mode ignores it.
      await (client as any).connectInternal({ autoLaunch: false, budget });
    } catch (err) {
      caught = err;
    } finally {
      stopHeartbeat(client);
    }

    expect(caught).toBeDefined();
    // Legacy path produces a plain Error (timeout message), not the typed budget error.
    expect(caught).not.toBeInstanceOf(SessionInitBudgetExhausted);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/i);
  }, 10000);

  test('without budget, connectInternal retries the fixed number of times', async () => {
    let attempts = 0;
    mockPuppeteerConnect.mockImplementation(() => {
      attempts++;
      return new Promise(() => { /* never resolves, lets the timer win */ });
    });

    const client = new CDPClient({ port: 9222, autoLaunch: false });
    let caught: unknown;
    try {
      await (client as any).connectInternal({ autoLaunch: false });
    } catch (err) {
      caught = err;
    } finally {
      stopHeartbeat(client);
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SessionInitBudgetExhausted);
    // 3 retries total, each hitting the mocked 200ms WS timeout.
    expect(attempts).toBe(3);
  }, 10000);

  test('succeeds on first attempt when puppeteer.connect resolves', async () => {
    const mockBrowser: any = {
      isConnected: jest.fn().mockReturnValue(true),
      wsEndpoint: jest.fn().mockReturnValue('ws://localhost:9222/devtools/browser/abc'),
      target: jest.fn().mockReturnValue({ createCDPSession: jest.fn() }),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
      targets: jest.fn().mockReturnValue([]),
      pages: jest.fn().mockResolvedValue([]),
    };
    mockPuppeteerConnect.mockResolvedValue(mockBrowser);

    const client = new CDPClient({ port: 9222, autoLaunch: false });
    const budget = createBudget(5000, 'session-init');
    await (client as any).connectInternal({ autoLaunch: false, budget });
    stopHeartbeat(client);

    expect(mockPuppeteerConnect).toHaveBeenCalledTimes(1);
    expect(budget.remaining()).toBeGreaterThan(0);
  }, 10000);
});
