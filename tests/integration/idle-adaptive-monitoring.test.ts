/// <reference types="jest" />
/**
 * Integration test for issue #649 §5.5 — idle-adaptive monitoring behaviour.
 *
 * Rather than spawning a real server for 5 real minutes (the acceptance
 * criterion says "simulated 5 min of silence"), this test exercises the
 * same wiring the server uses — the IdleState singleton, plus each of the
 * 7 in-scope monitors — and asserts that:
 *
 *   (a) after simulated 5 minutes of silence, every monitor's getCurrentDelayMs
 *       reports the idle rate;
 *   (b) after a synthetic RPC (modeled by IdleState.notifyActive() + the
 *       monitor's next scheduled delay read), every monitor reports the
 *       active rate on its next tick.
 *
 * A full real-process harness that spawns `dist/index.js serve` with a
 * stubbed Chrome is deferred to the benchmark script (scripts/bench-idle.mjs)
 * where CPU sampling happens anyway.
 */

import { EventLoopMonitor } from '../../src/watchdog/event-loop-monitor';
import { ChromeProcessWatchdog } from '../../src/chrome/process-watchdog';
import { TabHealthMonitor } from '../../src/cdp/tab-health-monitor';
import { ChromeProcessMonitor } from '../../src/watchdog/chrome-monitor';
import { DiskMonitor } from '../../src/watchdog/disk-monitor';
import { BrowserStateManager } from '../../src/browser-state/snapshot';
import { SessionStatePersistence } from '../../src/session-state-persistence';
import { createIdleState, IDLE_WINDOW_MS } from '../../src/utils/idle-state';

describe('idle-adaptive monitoring integration (issue #649 §5.5)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let tmpHome: string;
  let origHome: string | undefined;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-idle-itest-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('after 5 min of silence, every monitor transitions to its idle rate within one tick', async () => {
    let clock = 1_000_000;
    const idle = createIdleState({ now: () => clock });
    idle.notifyActive(); // start in active state

    const eventLoop = new EventLoopMonitor({ checkIntervalMs: 200, idleState: idle });
    const watchdog = new ChromeProcessWatchdog(
      { getInstance: () => null, intentionalStop: false, ensureChrome: async () => {} } as any,
      { intervalMs: 10_000, idleState: idle },
    );
    const tabHealth = new TabHealthMonitor({ probeIntervalMs: 60_000, idleState: idle });
    const chromeMon = new ChromeProcessMonitor({ intervalMs: 30_000, idleState: idle });
    const disk = new DiskMonitor({ checkIntervalMs: 5 * 60_000, idleState: idle });
    const browserState = new BrowserStateManager({ intervalMs: 60_000, idleState: idle });
    const persistence = new SessionStatePersistence({ dir: tmpHome, debounceMs: 5_000, idleState: idle });

    eventLoop.start();
    watchdog.start();
    tabHealth.monitorTab('t1', { evaluate: async () => 1 } as any);
    if (process.platform !== 'win32') chromeMon.start(process.pid);
    disk.start();
    await browserState.start();
    persistence.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });

    // Active rates confirmed.
    expect(eventLoop.getCurrentDelayMs()).toBe(200);
    expect(watchdog.getCurrentDelayMs()).toBe(10_000);
    expect(tabHealth.getCurrentDelayMs('t1')).toBe(60_000);
    if (process.platform !== 'win32') expect(chromeMon.getCurrentDelayMs()).toBe(30_000);
    expect(disk.getCurrentDelayMs()).toBe(5 * 60_000);
    expect(browserState.getCurrentDelayMs()).toBe(60_000);
    expect(persistence.getCurrentDebounceMs()).toBe(5_000);

    // Advance the fake clock past the 5-minute idle window.
    clock += IDLE_WINDOW_MS + 1_000;

    // Each monitor re-reads nextDelayMs() on its next scheduleNext. The
    // setTimeout-chain design means a restart() produces the next delay —
    // in production this happens naturally at the tick boundary.
    eventLoop.stop(); eventLoop.start();
    watchdog.stop(); watchdog.start();
    tabHealth.unmonitorTab('t1');
    tabHealth.monitorTab('t1', { evaluate: async () => 1 } as any);
    if (process.platform !== 'win32') { chromeMon.stop(); chromeMon.start(process.pid); }
    disk.stop(); disk.start();
    browserState.stop(); await browserState.start();
    persistence.cancelPendingSave();
    persistence.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });

    expect(eventLoop.getCurrentDelayMs()).toBe(2_000);
    expect(watchdog.getCurrentDelayMs()).toBe(60_000);
    expect(tabHealth.getCurrentDelayMs('t1')).toBe(300_000);
    if (process.platform !== 'win32') expect(chromeMon.getCurrentDelayMs()).toBe(180_000);
    expect(disk.getCurrentDelayMs()).toBe(30 * 60_000);
    expect(browserState.getCurrentDelayMs()).toBe(300_000);
    expect(persistence.getCurrentDebounceMs()).toBe(50_000);

    // Synthetic RPC: notifyActive() resets the window; next scheduling
    // must pick the active rate again.
    idle.notifyActive();

    eventLoop.stop(); eventLoop.start();
    watchdog.stop(); watchdog.start();
    tabHealth.unmonitorTab('t1');
    tabHealth.monitorTab('t1', { evaluate: async () => 1 } as any);
    if (process.platform !== 'win32') { chromeMon.stop(); chromeMon.start(process.pid); }
    disk.stop(); disk.start();
    browserState.stop(); await browserState.start();
    persistence.cancelPendingSave();
    persistence.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });

    expect(eventLoop.getCurrentDelayMs()).toBe(200);
    expect(watchdog.getCurrentDelayMs()).toBe(10_000);
    expect(tabHealth.getCurrentDelayMs('t1')).toBe(60_000);
    if (process.platform !== 'win32') expect(chromeMon.getCurrentDelayMs()).toBe(30_000);
    expect(disk.getCurrentDelayMs()).toBe(5 * 60_000);
    expect(browserState.getCurrentDelayMs()).toBe(60_000);
    expect(persistence.getCurrentDebounceMs()).toBe(5_000);

    // Cleanup.
    eventLoop.stop(); watchdog.stop(); tabHealth.stopAll();
    if (process.platform !== 'win32') chromeMon.stop();
    disk.stop(); browserState.stop(); persistence.cancelPendingSave();
  });
});
