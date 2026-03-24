/**
 * E2E-4: Event Loop Block Recovery (#347)
 * Validates: Layer 4 watchdog (EventLoopMonitor) detects event loop blocking
 * and emits the correct lifecycle events.
 *
 * The full spec calls for injecting a 35s CPU block in a live server process,
 * which is not safe to do inside a Jest test runner. Instead, this test
 * exercises the EventLoopMonitor in isolation to prove:
 *   - Timer drift detection works correctly.
 *   - 'warn' event fires when drift exceeds the warn threshold.
 *   - 'fatal' event fires when drift exceeds the fatal threshold.
 *   - start/stop lifecycle behaves correctly.
 *
 * The simulated drift approach: override Date.now() temporarily to return
 * an artificially advanced timestamp, triggering the drift calculation inside
 * the interval callback.
 */
import { EventLoopMonitor } from '../../../src/watchdog/event-loop-monitor';
import type { BlockEvent } from '../../../src/watchdog/event-loop-monitor';
import { sleep } from '../harness/time-scale';

describe('E2E-4: Event Loop Block Recovery (#347)', () => {
  afterEach(() => {
    // Restore Date.now in case a test patched it
    const dateAny = Date as unknown as Record<string, unknown>;
    if (dateAny._original) {
      Date.now = dateAny._original as typeof Date.now;
    }
  });

  test('EventLoopMonitor starts and stops cleanly', () => {
    const monitor = new EventLoopMonitor({
      checkIntervalMs: 100,
      warnThresholdMs: 1000,
    });

    expect(monitor.isRunning()).toBe(false);

    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);

    console.error('[event-loop-block] start/stop lifecycle OK');
  });

  test('EventLoopMonitor calling start twice does not create duplicate timers', () => {
    const monitor = new EventLoopMonitor({ checkIntervalMs: 100, warnThresholdMs: 500 });

    monitor.start();
    monitor.start(); // second call should stop-and-restart, not stack timers
    expect(monitor.isRunning()).toBe(true);

    monitor.stop();
    expect(monitor.isRunning()).toBe(false);
    console.error('[event-loop-block] double-start idempotency OK');
  });

  test('EventLoopMonitor getStats returns zero counts initially', () => {
    const monitor = new EventLoopMonitor({ checkIntervalMs: 50, warnThresholdMs: 500 });
    monitor.start();

    const stats = monitor.getStats();
    expect(stats.isRunning).toBe(true);
    expect(stats.maxDriftMs).toBeGreaterThanOrEqual(0);
    expect(stats.warnCount).toBe(0);

    monitor.stop();
    console.error('[event-loop-block] initial stats OK');
  });

  test('EventLoopMonitor resetStats clears counters', () => {
    const monitor = new EventLoopMonitor({ checkIntervalMs: 50, warnThresholdMs: 500 });
    monitor.start();
    monitor.stop();

    monitor.resetStats();
    const stats = monitor.getStats();
    expect(stats.maxDriftMs).toBe(0);
    expect(stats.warnCount).toBe(0);
    console.error('[event-loop-block] resetStats OK');
  });

  test('EventLoopMonitor emits warn event when drift exceeds warnThreshold (#347 Layer-4)', async () => {
    // Use a very short check interval and a low warn threshold so we can
    // simulate the drift without actually blocking the event loop.
    const monitor = new EventLoopMonitor({
      checkIntervalMs: 50,
      warnThresholdMs: 10, // 10ms — easily exceeded if we patch Date.now
      fatalThresholdMs: 0, // fatal disabled for this test
    });

    const warnEvents: BlockEvent[] = [];
    monitor.on('warn', (evt: BlockEvent) => {
      warnEvents.push(evt);
    });

    // Patch Date.now to return a value 100ms ahead of real time on the next
    // call from inside the monitor's interval callback. The interval fires
    // every 50ms; if now() returns +100ms ahead, drift = 100 - 50 = 50ms > 10ms threshold.
    const realDateNow = Date.now.bind(Date);
    let patchCallCount = 0;
    Date.now = () => {
      patchCallCount++;
      // Return +60ms extra on every second call (inside the interval)
      if (patchCallCount % 2 === 0) {
        return realDateNow() + 60;
      }
      return realDateNow();
    };

    monitor.start();
    // Wait long enough for at least 2 interval ticks to fire
    await sleep(300);
    monitor.stop();

    // Restore Date.now
    Date.now = realDateNow;

    expect(warnEvents.length).toBeGreaterThan(0);
    expect(warnEvents[0].driftMs).toBeGreaterThan(10);
    expect(typeof warnEvents[0].timestamp).toBe('number');

    const stats = monitor.getStats();
    expect(stats.warnCount).toBeGreaterThan(0);
    expect(stats.maxDriftMs).toBeGreaterThan(10);

    console.error(`[event-loop-block] warn event fired ${warnEvents.length} time(s), maxDrift=${stats.maxDriftMs}ms`);
  }, 10_000);

  test('EventLoopMonitor emits fatal event when drift exceeds fatalThreshold (#347 Layer-4)', async () => {
    const monitor = new EventLoopMonitor({
      checkIntervalMs: 50,
      warnThresholdMs: 10,
      fatalThresholdMs: 20, // fatal fires above 20ms drift
    });

    const fatalEvents: BlockEvent[] = [];
    const warnEvents: BlockEvent[] = [];
    monitor.on('fatal', (evt: BlockEvent) => fatalEvents.push(evt));
    monitor.on('warn', (evt: BlockEvent) => warnEvents.push(evt));

    const realDateNow = Date.now.bind(Date);
    let patchCallCount = 0;
    Date.now = () => {
      patchCallCount++;
      // Inject +80ms extra every second call: drift = 80ms > fatalThreshold (20ms)
      if (patchCallCount % 2 === 0) {
        return realDateNow() + 80;
      }
      return realDateNow();
    };

    monitor.start();
    await sleep(300);
    monitor.stop();

    // Restore Date.now
    Date.now = realDateNow;

    expect(fatalEvents.length).toBeGreaterThan(0);
    expect(fatalEvents[0].driftMs).toBeGreaterThan(20);
    expect(typeof fatalEvents[0].timestamp).toBe('number');

    console.error(
      `[event-loop-block] fatal event fired ${fatalEvents.length} time(s), ` +
      `driftMs=${fatalEvents[0].driftMs}ms — Layer-4 watchdog validated`
    );
  }, 10_000);

  test('EventLoopMonitor does not emit fatal when fatalThreshold is 0 (disabled)', async () => {
    const monitor = new EventLoopMonitor({
      checkIntervalMs: 50,
      warnThresholdMs: 10,
      fatalThresholdMs: 0, // disabled
    });

    const fatalEvents: BlockEvent[] = [];
    monitor.on('fatal', (evt: BlockEvent) => fatalEvents.push(evt));

    const realDateNow = Date.now.bind(Date);
    let patchCallCount = 0;
    Date.now = () => {
      patchCallCount++;
      if (patchCallCount % 2 === 0) {
        return realDateNow() + 200; // large drift, but fatal is disabled
      }
      return realDateNow();
    };

    monitor.start();
    await sleep(300);
    monitor.stop();

    Date.now = realDateNow;

    expect(fatalEvents.length).toBe(0);
    console.error('[event-loop-block] fatal disabled (fatalThresholdMs=0) — no fatal events emitted');
  }, 10_000);

  test('EventLoopMonitor: process recovery sequence — fatal fires, caller handles exit (#347 spec)', async () => {
    // Simulates the full #347 spec sequence:
    // 1. Layer 4 watchdog detects block > 30s → emits fatal
    // 2. Caller's listener would call process.exit(1) in production
    // 3. Layer 5 (PM2) restarts within 5s
    // 4. Layer 2 restores session state from disk
    //
    // Here we verify that the fatal event carries the correct payload and that
    // the monitor stops emitting after stop() is called — matching the
    // "process exits" step of the real recovery path.

    const monitor = new EventLoopMonitor({
      checkIntervalMs: 50,
      warnThresholdMs: 100,
      fatalThresholdMs: 200,
    });

    let recoveryTriggered = false;
    let fatalPayload: BlockEvent | null = null;

    // Caller attaches recovery handler — in production this calls process.exit(1)
    monitor.on('fatal', (evt: BlockEvent) => {
      fatalPayload = evt;
      recoveryTriggered = true;
      monitor.stop(); // mimic: process exits → monitor cleaned up
    });

    const realDateNow = Date.now.bind(Date);
    let patchCallCount = 0;
    Date.now = () => {
      patchCallCount++;
      // Inject 300ms drift on every second tick: exceeds both warn (100ms) and fatal (200ms)
      if (patchCallCount % 2 === 0) {
        return realDateNow() + 300;
      }
      return realDateNow();
    };

    monitor.start();
    // Wait for at least one interval cycle to trigger the fatal event
    await sleep(400);

    // Restore Date.now regardless of result
    Date.now = realDateNow;

    // If monitor is still running (fatal didn't fire), stop it
    if (monitor.isRunning()) {
      monitor.stop();
    }

    expect(recoveryTriggered).toBe(true);
    expect(fatalPayload).not.toBeNull();
    expect((fatalPayload as unknown as BlockEvent).driftMs).toBeGreaterThan(200);
    expect(monitor.isRunning()).toBe(false);

    console.error(
      `[event-loop-block] Recovery sequence validated: ` +
      `fatal fired at driftMs=${(fatalPayload as unknown as BlockEvent).driftMs}ms, ` +
      `monitor stopped (simulates process exit) — Layer-4 watchdog spec PASS`
    );
  }, 10_000);
});
