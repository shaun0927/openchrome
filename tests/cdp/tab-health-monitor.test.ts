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

    // Wait for enough probes to exceed threshold
    await new Promise(r => setTimeout(r, 150));

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

    await new Promise(r => setTimeout(r, 150));

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

    await new Promise(r => setTimeout(r, 150));

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

    await new Promise(r => setTimeout(r, 200));

    expect(unhealthyHandler).toHaveBeenCalled();

    monitor.stopAll();
  });
});
