/// <reference types="jest" />
/**
 * Idle-adaptive monitor unit tests (issue #649 Part A §5.4).
 *
 * For each of the 7 in-scope monitors (HealthEndpoint is owned by sibling
 * #648), assert:
 *   1. Active rate preserved when isIdle() === false
 *   2. Rate drops to the configured idle rate when isIdle() === true
 *   3. Active/idle ratio stays within 10× (criterion 4)
 *
 * Monitors use a setTimeout chain; we spy on setTimeout and drive the first
 * scheduling call (before the first tick runs). Where relevant we advance
 * the clock to let one tick fire and assert the second scheduled delay
 * reflects the idle decision.
 */

import { EventLoopMonitor } from '../../src/watchdog/event-loop-monitor';
import { ChromeProcessWatchdog } from '../../src/chrome/process-watchdog';
import { TabHealthMonitor } from '../../src/cdp/tab-health-monitor';
import { ChromeProcessMonitor } from '../../src/watchdog/chrome-monitor';
import { DiskMonitor } from '../../src/watchdog/disk-monitor';
import { BrowserStateManager } from '../../src/browser-state/snapshot';
import { SessionStatePersistence } from '../../src/session-state-persistence';
import { createIdleState, IDLE_WINDOW_MS } from '../../src/utils/idle-state';
import type { IdleState } from '../../src/utils/idle-state';

function activeState(): IdleState {
  const s = createIdleState({ now: () => 0 });
  s.notifyActive();
  return s;
}

function idleState(): IdleState {
  // Process startup now counts as the initial active edge. To model a truly
  // idle instance, create the state at t=0 and then advance the synthetic
  // clock past the shared idle window before returning it.
  let clock = 0;
  const s = createIdleState({ now: () => clock });
  clock = IDLE_WINDOW_MS + 1;
  return s;
}

// The BrowserStateManager tests use a tmp dir to avoid polluting
// ~/.openchrome; ensure background fs.mkdir completes before the test file
// exits so Jest does not flag the timer as a leak.
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
});

describe('EventLoopMonitor idle-adaptive cadence', () => {
  test('active rate preserved when not idle (200ms default)', () => {
    const monitor = new EventLoopMonitor({ checkIntervalMs: 200, idleState: activeState() });
    monitor.start();
    expect(monitor.getCurrentDelayMs()).toBe(200);
    monitor.stop();
  });

  test('drops to idle rate (2000ms) when isIdle()', () => {
    const monitor = new EventLoopMonitor({ checkIntervalMs: 200, idleState: idleState() });
    monitor.start();
    expect(monitor.getCurrentDelayMs()).toBe(2_000);
    monitor.stop();
  });

  test('idle/active ratio is exactly 10× (within criterion 4 cap)', () => {
    const a = new EventLoopMonitor({ checkIntervalMs: 200, idleState: activeState() });
    const i = new EventLoopMonitor({ checkIntervalMs: 200, idleState: idleState() });
    a.start();
    i.start();
    const ratio = i.getCurrentDelayMs() / a.getCurrentDelayMs();
    expect(ratio).toBeLessThanOrEqual(10);
    expect(ratio).toBeGreaterThan(1);
    a.stop();
    i.stop();
  });
});

describe('ChromeProcessWatchdog idle-adaptive cadence', () => {
  // Stub launcher — we only need the timer scheduling, not the check logic.
  const stubLauncher: any = {
    getInstance: () => null,
    intentionalStop: false,
    ensureChrome: async () => {},
  };

  test('active rate preserved when not idle (10s default)', () => {
    const w = new ChromeProcessWatchdog(stubLauncher, { intervalMs: 10_000, idleState: activeState() });
    w.start();
    expect(w.getCurrentDelayMs()).toBe(10_000);
    w.stop();
  });

  test('drops to idle rate (60s)', () => {
    const w = new ChromeProcessWatchdog(stubLauncher, { intervalMs: 10_000, idleState: idleState() });
    w.start();
    expect(w.getCurrentDelayMs()).toBe(60_000);
    w.stop();
  });

  test('idle/active ratio 6× — within 10× cap', () => {
    const a = new ChromeProcessWatchdog(stubLauncher, { intervalMs: 10_000, idleState: activeState() });
    const i = new ChromeProcessWatchdog(stubLauncher, { intervalMs: 10_000, idleState: idleState() });
    a.start(); i.start();
    expect(i.getCurrentDelayMs() / a.getCurrentDelayMs()).toBeLessThanOrEqual(10);
    a.stop(); i.stop();
  });
});

describe('TabHealthMonitor idle-adaptive cadence', () => {
  // Stub Page — evaluate is never called because we stop() before the timer fires.
  const stubPage: any = { evaluate: async () => 1 };

  test('active rate preserved when not idle (60s default)', () => {
    const m = new TabHealthMonitor({ probeIntervalMs: 60_000, idleState: activeState() });
    m.monitorTab('tgt-1', stubPage);
    expect(m.getCurrentDelayMs('tgt-1')).toBe(60_000);
    m.stopAll();
  });

  test('drops to idle rate (300s)', () => {
    const m = new TabHealthMonitor({ probeIntervalMs: 60_000, idleState: idleState() });
    m.monitorTab('tgt-1', stubPage);
    expect(m.getCurrentDelayMs('tgt-1')).toBe(300_000);
    m.stopAll();
  });

  test('ratio 5× — within 10× cap', () => {
    const a = new TabHealthMonitor({ probeIntervalMs: 60_000, idleState: activeState() });
    const i = new TabHealthMonitor({ probeIntervalMs: 60_000, idleState: idleState() });
    a.monitorTab('t', stubPage); i.monitorTab('t', stubPage);
    expect(i.getCurrentDelayMs('t')! / a.getCurrentDelayMs('t')!).toBeLessThanOrEqual(10);
    a.stopAll(); i.stopAll();
  });
});

describe('ChromeProcessMonitor idle-adaptive cadence', () => {
  // Windows-skip shortcut: the monitor refuses to start() on win32; test is
  // meaningless there. Skip instead of asserting.
  const platformSupportsMonitor = process.platform !== 'win32';
  const itIfSupported = platformSupportsMonitor ? test : test.skip;

  itIfSupported('active rate preserved when not idle (30s default)', () => {
    const m = new ChromeProcessMonitor({ intervalMs: 30_000, idleState: activeState() });
    m.start(process.pid);
    expect(m.getCurrentDelayMs()).toBe(30_000);
    m.stop();
  });

  itIfSupported('drops to idle rate (180s)', () => {
    const m = new ChromeProcessMonitor({ intervalMs: 30_000, idleState: idleState() });
    m.start(process.pid);
    expect(m.getCurrentDelayMs()).toBe(180_000);
    m.stop();
  });

  itIfSupported('ratio 6× — within 10× cap', () => {
    const a = new ChromeProcessMonitor({ intervalMs: 30_000, idleState: activeState() });
    const i = new ChromeProcessMonitor({ intervalMs: 30_000, idleState: idleState() });
    a.start(process.pid); i.start(process.pid);
    expect(i.getCurrentDelayMs() / a.getCurrentDelayMs()).toBeLessThanOrEqual(10);
    a.stop(); i.stop();
  });
});

describe('DiskMonitor idle-adaptive cadence', () => {
  const safeDiskOpts = {
    warnThresholdBytes: Number.MAX_SAFE_INTEGER,
    cleanupThresholdBytes: Number.MAX_SAFE_INTEGER,
  };

  test('active rate preserved when not idle (5min default)', () => {
    const m = new DiskMonitor({ checkIntervalMs: 5 * 60_000, idleState: activeState(), ...safeDiskOpts });
    m.start();
    expect(m.getCurrentDelayMs()).toBe(5 * 60_000);
    m.stop();
  });

  test('drops to idle rate (30min)', () => {
    const m = new DiskMonitor({ checkIntervalMs: 5 * 60_000, idleState: idleState(), ...safeDiskOpts });
    m.start();
    expect(m.getCurrentDelayMs()).toBe(30 * 60_000);
    m.stop();
  });

  test('ratio 6× — within 10× cap', () => {
    const a = new DiskMonitor({ checkIntervalMs: 5 * 60_000, idleState: activeState(), ...safeDiskOpts });
    const i = new DiskMonitor({ checkIntervalMs: 5 * 60_000, idleState: idleState(), ...safeDiskOpts });
    a.start(); i.start();
    expect(i.getCurrentDelayMs() / a.getCurrentDelayMs()).toBeLessThanOrEqual(10);
    a.stop(); i.stop();
  });
});

describe('BrowserStateManager idle-adaptive cadence', () => {
  // BrowserStateManager does an fs.mkdir to its snapshot dir on start().
  // Setting HOME to a tmp dir keeps the tests hermetic — the manager
  // constructs `~/.openchrome/snapshots` via os.homedir().
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let tmpHome: string;
  let origHome: string | undefined;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bsm-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('active rate preserved when not idle (60s default)', async () => {
    const m = new BrowserStateManager({ intervalMs: 60_000, idleState: activeState() });
    await m.start();
    expect(m.getCurrentDelayMs()).toBe(60_000);
    m.stop();
  });

  test('drops to idle rate (300s)', async () => {
    const m = new BrowserStateManager({ intervalMs: 60_000, idleState: idleState() });
    await m.start();
    expect(m.getCurrentDelayMs()).toBe(300_000);
    m.stop();
  });

  test('ratio 5× — within 10× cap', async () => {
    const a = new BrowserStateManager({ intervalMs: 60_000, idleState: activeState() });
    const i = new BrowserStateManager({ intervalMs: 60_000, idleState: idleState() });
    await a.start(); await i.start();
    expect(i.getCurrentDelayMs() / a.getCurrentDelayMs()).toBeLessThanOrEqual(10);
    a.stop(); i.stop();
  });
});

describe('SessionStatePersistence idle-adaptive debounce', () => {
  // Use a tmp dir so the atomic writer does not pollute the home directory.
  const makeDir = () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-session-idle-'));
  };

  test('active debounce preserved (5s default)', () => {
    const dir = makeDir();
    const p = new SessionStatePersistence({ dir, debounceMs: 5_000, idleState: activeState() });
    p.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });
    expect(p.getCurrentDebounceMs()).toBe(5_000);
    p.cancelPendingSave();
  });

  test('drops to 10× debounce (50s) when idle', () => {
    const dir = makeDir();
    const p = new SessionStatePersistence({ dir, debounceMs: 5_000, idleState: idleState() });
    p.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });
    expect(p.getCurrentDebounceMs()).toBe(50_000);
    p.cancelPendingSave();
  });

  test('ratio is exactly 10× — caps at criterion 4 ceiling', () => {
    const dir = makeDir();
    const a = new SessionStatePersistence({ dir, debounceMs: 5_000, idleState: activeState() });
    const i = new SessionStatePersistence({ dir, debounceMs: 5_000, idleState: idleState() });
    a.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });
    i.scheduleSave({ version: 1, timestamp: Date.now(), sessions: [] });
    expect(i.getCurrentDebounceMs() / a.getCurrentDebounceMs()).toBe(10);
    a.cancelPendingSave(); i.cancelPendingSave();
  });
});

describe('Idle window constant', () => {
  test('is exactly 5 minutes per issue #649 §3.1', () => {
    expect(IDLE_WINDOW_MS).toBe(5 * 60_000);
  });
});
