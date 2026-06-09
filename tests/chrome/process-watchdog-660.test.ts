/// <reference types="jest" />

/**
 * #660 — watchdog should NOT relaunch when:
 *   1. launcher.quiesceUntil is in the future (user-driven close).
 *   2. instance.launchMode === 'attach' (user-owned Chrome).
 *   3. recent crashes exceed the rate limit.
 */

import { ChromeProcessWatchdog } from '../../src/chrome/process-watchdog';

function makeLauncher(overrides: Record<string, unknown> = {}) {
  return {
    getInstance: jest.fn().mockReturnValue(null),
    ensureChrome: jest.fn().mockResolvedValue(undefined),
    isLaunching: jest.fn().mockReturnValue(false),
    intentionalStop: false,
    quiesceUntil: 0,
    recentCrashesMs: [],
    clearQuiesce: jest.fn(),
    ...overrides,
  } as any;
}

async function tickOnce(intervalMs: number) {
  await new Promise((r) => setTimeout(r, intervalMs + 60));
}

describe('ChromeProcessWatchdog #660 quiesce', () => {
  let watchdog: ChromeProcessWatchdog;

  afterEach(() => {
    if (watchdog) watchdog.stop();
  });

  it('skips relaunch while quiesceUntil is in the future', async () => {
    const dead = 99999998;
    const ensureChrome = jest.fn().mockResolvedValue(undefined);
    const launcher = makeLauncher({
      ensureChrome,
      getInstance: jest.fn()
        .mockReturnValueOnce({ process: { pid: dead } })
        .mockReturnValue(null),
      quiesceUntil: Date.now() + 60_000,
    });

    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 100 });
    watchdog.start();

    await tickOnce(100);
    await tickOnce(100);

    expect(ensureChrome).not.toHaveBeenCalled();
  });

  it('skips relaunch when launchMode === "attach"', async () => {
    const userChromePid = 99999997;
    const ensureChrome = jest.fn().mockResolvedValue(undefined);
    const launcher = makeLauncher({
      ensureChrome,
      // Even if Chrome dies in attach mode (the user closed their own browser),
      // we never relaunch — that's not our process to manage.
      getInstance: jest.fn().mockReturnValue({
        process: { pid: userChromePid },
        launchMode: 'attach',
      }),
    });

    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 100 });
    watchdog.start();
    await tickOnce(100);
    await tickOnce(100);

    expect(ensureChrome).not.toHaveBeenCalled();
  });

  it('rate-limits relaunch when ≥3 crashes within 60s', async () => {
    const dead = 99999996;
    const now = Date.now();
    const ensureChrome = jest.fn().mockResolvedValue(undefined);
    const launcher = makeLauncher({
      ensureChrome,
      getInstance: jest.fn()
        .mockReturnValueOnce({ process: { pid: dead } })
        .mockReturnValue(null),
      // Three recent crashes inside the 60s window.
      recentCrashesMs: [now - 5_000, now - 10_000, now - 20_000],
    });

    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 100 });
    const relaunchFailed = jest.fn();
    watchdog.on('relaunch-failed', relaunchFailed);
    watchdog.start();
    await tickOnce(100);

    expect(ensureChrome).not.toHaveBeenCalled();
    // #1474: the rate-limit branch must emit relaunch-failed so owner
    // self-release can observe this otherwise-silent irrecoverable state.
    expect(relaunchFailed).toHaveBeenCalled();
  });
});
