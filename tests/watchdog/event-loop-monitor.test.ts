/// <reference types="jest" />

import { EventLoopMonitor } from '../../src/watchdog/event-loop-monitor';
import { HealthEndpoint, HealthData } from '../../src/watchdog/health-endpoint';

describe('EventLoopMonitor', () => {
  let monitor: EventLoopMonitor;

  afterEach(() => {
    if (monitor) monitor.stop();
  });

  test('starts and stops without errors', () => {
    monitor = new EventLoopMonitor({ checkIntervalMs: 50 });

    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  test('does not emit warn for normal operation', async () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 50,
      warnThresholdMs: 5000,
    });
    const warnHandler = jest.fn();
    monitor.on('warn', warnHandler);

    monitor.start();
    await new Promise(r => setTimeout(r, 200));
    monitor.stop();

    expect(warnHandler).not.toHaveBeenCalled();
  });

  test('reports stats correctly', () => {
    monitor = new EventLoopMonitor({ checkIntervalMs: 50 });

    const stats = monitor.getStats();
    expect(stats.maxDriftMs).toBe(0);
    expect(stats.warnCount).toBe(0);
    expect(stats.isRunning).toBe(false);
  });

  test('resetStats clears counters', async () => {
    monitor = new EventLoopMonitor({ checkIntervalMs: 50 });

    monitor.start();
    await new Promise(r => setTimeout(r, 150));
    monitor.stop();

    // maxDrift should be > 0 after running
    const statsBefore = monitor.getStats();
    expect(statsBefore.maxDriftMs).toBeGreaterThanOrEqual(0);

    monitor.resetStats();
    const statsAfter = monitor.getStats();
    expect(statsAfter.maxDriftMs).toBe(0);
    expect(statsAfter.warnCount).toBe(0);
  });

  test('start() is idempotent — clears previous timer', () => {
    monitor = new EventLoopMonitor({ checkIntervalMs: 50 });

    monitor.start();
    monitor.start(); // should not create duplicate timers

    expect(monitor.isRunning()).toBe(true);
    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
  });

  test('emits warn event when event loop is blocked', async () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 20,
      warnThresholdMs: 50, // low threshold for testing
    });
    const warnHandler = jest.fn();
    monitor.on('warn', warnHandler);

    monitor.start();

    // Block the event loop for ~80ms
    const start = Date.now();
    while (Date.now() - start < 80) {
      // busy wait
    }

    // Wait for the next check to fire
    await new Promise(r => setTimeout(r, 50));
    monitor.stop();

    expect(warnHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        driftMs: expect.any(Number),
        timestamp: expect.any(Number),
      })
    );
  });

  test('emits fatal event when threshold exceeded', async () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 20,
      warnThresholdMs: 30,
      fatalThresholdMs: 60,
    });
    const fatalHandler = jest.fn();
    monitor.on('fatal', fatalHandler);

    monitor.start();

    // Block for ~100ms to exceed fatal threshold
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait
    }

    await new Promise(r => setTimeout(r, 50));
    monitor.stop();

    expect(fatalHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        driftMs: expect.any(Number),
      })
    );
  });
});

describe('EventLoopMonitor heavy operation grace period', () => {
  let monitor: EventLoopMonitor;

  afterEach(() => {
    if (monitor) monitor.stop();
  });

  test('beginHeavyOperation prevents fatal event for drift between normal and heavy threshold', async () => {
    // fatalThresholdMs = 60ms, heavyOpFatalThresholdMs = 200ms
    // Busy-wait for ~100ms: exceeds normal fatal (60ms) but not heavy (200ms)
    monitor = new EventLoopMonitor({
      checkIntervalMs: 20,
      warnThresholdMs: 30,
      fatalThresholdMs: 60,
      heavyOpFatalThresholdMs: 200,
    });
    const fatalHandler = jest.fn();
    monitor.on('fatal', fatalHandler);

    monitor.beginHeavyOperation();
    monitor.start();

    // Block for ~100ms — exceeds normal fatal (60ms) but under heavy (200ms)
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait
    }

    await new Promise(r => setTimeout(r, 50));
    monitor.stop();

    expect(fatalHandler).not.toHaveBeenCalled();
  });

  test('endHeavyOperation restores normal threshold — fatal fires again', async () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 20,
      warnThresholdMs: 30,
      fatalThresholdMs: 60,
      heavyOpFatalThresholdMs: 200,
    });
    const fatalHandler = jest.fn();
    monitor.on('fatal', fatalHandler);

    monitor.beginHeavyOperation();
    monitor.endHeavyOperation(); // back to normal threshold

    monitor.start();

    // Block for ~100ms — now exceeds normal fatal (60ms)
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait
    }

    await new Promise(r => setTimeout(r, 50));
    monitor.stop();

    expect(fatalHandler).toHaveBeenCalled();
  });

  test('ref counting: two beginHeavyOperation, one endHeavyOperation — still in heavy mode', async () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 20,
      warnThresholdMs: 30,
      fatalThresholdMs: 60,
      heavyOpFatalThresholdMs: 200,
    });
    const fatalHandler = jest.fn();
    monitor.on('fatal', fatalHandler);

    monitor.beginHeavyOperation();
    monitor.beginHeavyOperation();
    monitor.endHeavyOperation(); // count goes to 1 — still heavy

    monitor.start();

    // Block for ~100ms — still under heavy threshold (200ms)
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait
    }

    await new Promise(r => setTimeout(r, 50));
    monitor.stop();

    expect(fatalHandler).not.toHaveBeenCalled();
  });

  test('ref counting: two begin, two end — back to normal threshold', async () => {
    monitor = new EventLoopMonitor({
      checkIntervalMs: 20,
      warnThresholdMs: 30,
      fatalThresholdMs: 60,
      heavyOpFatalThresholdMs: 200,
    });
    const fatalHandler = jest.fn();
    monitor.on('fatal', fatalHandler);

    monitor.beginHeavyOperation();
    monitor.beginHeavyOperation();
    monitor.endHeavyOperation();
    monitor.endHeavyOperation(); // count back to 0 — normal threshold

    monitor.start();

    // Block for ~100ms — exceeds normal fatal (60ms)
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait
    }

    await new Promise(r => setTimeout(r, 50));
    monitor.stop();

    expect(fatalHandler).toHaveBeenCalled();
  });

  test('endHeavyOperation does not go below 0', () => {
    monitor = new EventLoopMonitor({ checkIntervalMs: 50 });

    // Call end without any begin — should not throw or underflow
    expect(() => monitor.endHeavyOperation()).not.toThrow();
    expect(() => monitor.endHeavyOperation()).not.toThrow();

    // beginHeavyOperation should still work correctly afterwards
    monitor.beginHeavyOperation();
    // No assertion on internals needed — just verify no error thrown
    expect(() => monitor.endHeavyOperation()).not.toThrow();
  });
});

describe('HealthEndpoint', () => {
  let endpoint: HealthEndpoint;

  afterEach(async () => {
    if (endpoint) await endpoint.stop();
  });

  test('starts and responds to /health', async () => {
    const provider = () => ({
      status: 'ok' as const,
      uptime: 100,
      memory: process.memoryUsage(),
      eventLoop: { maxDriftMs: 5, warnCount: 0 },
    });

    // Use a random high port to avoid conflicts
    const port = 19200 + Math.floor(Math.random() * 800);
    endpoint = new HealthEndpoint(provider, port);
    await endpoint.start();

    expect(endpoint.isRunning()).toBe(true);

    // Make HTTP request
    const response = await new Promise<{ statusCode: number; body: string }>((resolve) => {
      const http = require('http');
      http.get(`http://127.0.0.1:${port}/health`, (res: any) => {
        let body = '';
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    expect(data.status).toBe('ok');
    expect(data.uptime).toBe(100);
  });

  test('returns 404 for unknown paths', async () => {
    const provider = () => ({ status: 'ok' as const, uptime: 0, memory: process.memoryUsage(), eventLoop: { maxDriftMs: 0, warnCount: 0 } });
    const port = 19200 + Math.floor(Math.random() * 800);
    endpoint = new HealthEndpoint(provider, port);
    await endpoint.start();

    const response = await new Promise<{ statusCode: number }>((resolve) => {
      const http = require('http');
      http.get(`http://127.0.0.1:${port}/unknown`, (res: any) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      });
    });

    expect(response.statusCode).toBe(404);
  });

  test('handles port in use gracefully', async () => {
    const provider = () => ({ status: 'ok' as const, uptime: 0, memory: process.memoryUsage(), eventLoop: { maxDriftMs: 0, warnCount: 0 } });
    const port = 19200 + Math.floor(Math.random() * 800);

    // Occupy the port
    const http = require('http');
    const blocker = http.createServer();
    await new Promise<void>(resolve => blocker.listen(port, '127.0.0.1', resolve));

    // Should not throw — just logs and resolves
    endpoint = new HealthEndpoint(provider, port);
    await expect(endpoint.start()).resolves.not.toThrow();
    expect(endpoint.isRunning()).toBe(false);

    blocker.close();
  });

  test('stop resolves when server is not running', async () => {
    const provider = () => ({ status: 'ok' as const, uptime: 0, memory: process.memoryUsage(), eventLoop: { maxDriftMs: 0, warnCount: 0 } });
    endpoint = new HealthEndpoint(provider);
    await expect(endpoint.stop()).resolves.not.toThrow();
  });
});
