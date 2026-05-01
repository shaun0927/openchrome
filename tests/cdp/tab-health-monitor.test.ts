/// <reference types="jest" />

import { TabHealthMonitor } from '../../src/cdp/tab-health-monitor';
import { Page } from 'puppeteer-core';

function createMockPage(opts: {
  evaluateResult?: unknown;
  evaluateError?: Error;
  evaluateDelay?: number;
} = {}): jest.Mocked<Pick<Page, 'evaluate'>> {
  const evaluate = jest.fn().mockImplementation(async () => {
    if (opts.evaluateDelay) {
      await new Promise(r => setTimeout(r, opts.evaluateDelay));
    }
    if (opts.evaluateError) throw opts.evaluateError;
    return opts.evaluateResult ?? 1;
  });
  return { evaluate } as unknown as jest.Mocked<Pick<Page, 'evaluate'>>;
}

// Polls `predicate` until it returns truthy or `timeoutMs` elapses. Replaces
// fixed `setTimeout` waits that were brittle on loaded CI runners — the
// probe interval is 30ms but a single jest worker tick on the GitHub
// Actions runners can stretch well past that under contention.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become truthy within ${timeoutMs}ms`);
}

describe('TabHealthMonitor', () => {
  let monitor: TabHealthMonitor;

  afterEach(() => {
    if (monitor) monitor.stopAll();
  });

  test('monitors and unmonitors tabs', () => {
    monitor = new TabHealthMonitor({ probeIntervalMs: 100 });
    const page = createMockPage();

    monitor.monitorTab('tab1', page as unknown as Page);
    expect(monitor.getMonitoredTabCount()).toBe(1);

    monitor.unmonitorTab('tab1');
    expect(monitor.getMonitoredTabCount()).toBe(0);
  });

  test('reports healthy tab after successful probe', async () => {
    monitor = new TabHealthMonitor({ probeIntervalMs: 50, probeTimeoutMs: 1000 });
    const page = createMockPage();
    const healthyHandler = jest.fn();
    monitor.on('tab-healthy', healthyHandler);

    monitor.monitorTab('tab1', page as unknown as Page);

    await new Promise(r => setTimeout(r, 120));

    const health = monitor.getTabHealth('tab1');
    expect(health?.status).toBe('healthy');
    expect(health?.consecutiveFailures).toBe(0);

    monitor.stopAll();
  });

  test('marks tab unhealthy after threshold failures', async () => {
    monitor = new TabHealthMonitor({
      probeIntervalMs: 30,
      probeTimeoutMs: 10,
      unhealthyThreshold: 2,
      evictionThreshold: 5,
    });
    const page = createMockPage({ evaluateError: new Error('renderer crashed') });
    const unhealthyHandler = jest.fn();
    monitor.on('tab-unhealthy', unhealthyHandler);

    monitor.monitorTab('tab1', page as unknown as Page);

    await waitFor(() => unhealthyHandler.mock.calls.length > 0);

    expect(unhealthyHandler).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'tab1' })
    );

    monitor.stopAll();
  });

  test('emits tab-evict after eviction threshold', async () => {
    monitor = new TabHealthMonitor({
      probeIntervalMs: 20,
      probeTimeoutMs: 10,
      unhealthyThreshold: 1,
      evictionThreshold: 2,
    });
    const page = createMockPage({ evaluateError: new Error('dead') });
    const evictHandler = jest.fn();
    monitor.on('tab-evict', evictHandler);

    monitor.monitorTab('tab1', page as unknown as Page);

    await waitFor(() => evictHandler.mock.calls.length > 0);

    expect(evictHandler).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'tab1' })
    );
    // Tab should be unmonitored after eviction
    expect(monitor.getMonitoredTabCount()).toBe(0);

    monitor.stopAll();
  });

  test('tab recovers after transient failure', async () => {
    monitor = new TabHealthMonitor({
      probeIntervalMs: 30,
      probeTimeoutMs: 100,
      unhealthyThreshold: 3,
    });

    let callCount = 0;
    const page = {
      evaluate: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) throw new Error('transient');
        return 1;
      }),
    } as unknown as Page;

    monitor.monitorTab('tab1', page);

    // First a failure recovers to healthy: wait until probe count is high
    // enough that we have observed at least one healthy result after the
    // initial transient failure.
    await waitFor(() => {
      const h = monitor.getTabHealth('tab1');
      return h !== undefined && h.status === 'healthy' && h.consecutiveFailures === 0 && callCount >= 2;
    });

    const health = monitor.getTabHealth('tab1');
    expect(health?.status).toBe('healthy');
    expect(health?.consecutiveFailures).toBe(0);

    monitor.stopAll();
  });

  test('getAllHealth returns copy of health map', () => {
    monitor = new TabHealthMonitor({ probeIntervalMs: 1000 });
    const page = createMockPage();

    monitor.monitorTab('tab1', page as unknown as Page);
    monitor.monitorTab('tab2', page as unknown as Page);

    const allHealth = monitor.getAllHealth();
    expect(allHealth.size).toBe(2);
    expect(allHealth.get('tab1')?.status).toBe('healthy');
    expect(allHealth.get('tab2')?.status).toBe('healthy');

    monitor.stopAll();
  });

  test('stopAll clears all monitors', () => {
    monitor = new TabHealthMonitor({ probeIntervalMs: 1000 });
    const page = createMockPage();

    monitor.monitorTab('tab1', page as unknown as Page);
    monitor.monitorTab('tab2', page as unknown as Page);
    monitor.monitorTab('tab3', page as unknown as Page);

    expect(monitor.getMonitoredTabCount()).toBe(3);

    monitor.stopAll();

    expect(monitor.getMonitoredTabCount()).toBe(0);
  });

  test('monitorTab replaces existing monitor for same targetId', () => {
    monitor = new TabHealthMonitor({ probeIntervalMs: 1000 });
    const page1 = createMockPage();
    const page2 = createMockPage();

    monitor.monitorTab('tab1', page1 as unknown as Page);
    monitor.monitorTab('tab1', page2 as unknown as Page);

    expect(monitor.getMonitoredTabCount()).toBe(1);

    monitor.stopAll();
  });

  test('probe timeout detects hanging renderer', async () => {
    monitor = new TabHealthMonitor({
      probeIntervalMs: 30,
      probeTimeoutMs: 20, // very short timeout
      unhealthyThreshold: 2,
    });
    // Page that takes too long to respond
    const page = createMockPage({ evaluateDelay: 500 });
    const unhealthyHandler = jest.fn();
    monitor.on('tab-unhealthy', unhealthyHandler);

    monitor.monitorTab('tab1', page as unknown as Page);

    await waitFor(() => unhealthyHandler.mock.calls.length > 0);

    expect(unhealthyHandler).toHaveBeenCalled();

    monitor.stopAll();
  });
});
