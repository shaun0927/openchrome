/// <reference types="jest" />
import { installParentWatcher } from '../../src/utils/parent-watcher';

async function tickIntervals(times: number, intervalMs: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    jest.advanceTimersByTime(intervalMs);
    // Yield once so microtasks scheduled by the timer callback can run.
    await Promise.resolve();
  }
}

describe('installParentWatcher', () => {
  let exitCalls: number[];
  let logs: string[];
  let exitFn: jest.Mock;
  let logger: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    exitCalls = [];
    logs = [];
    exitFn = jest.fn((code: number) => { exitCalls.push(code); });
    logger = jest.fn((msg: string) => { logs.push(msg); });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('exits with code 0 once the parent is no longer alive', async () => {
    let alive = true;
    const isAliveFn = jest.fn(() => alive);

    installParentWatcher({
      parentPid: 12345,
      intervalMs: 500,
      isAliveFn,
      exitFn,
      logger,
    });

    await tickIntervals(1, 500);
    expect(exitFn).not.toHaveBeenCalled();

    alive = false;
    await tickIntervals(1, 500);

    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitCalls[0]).toBe(0);
    expect(logs.some((m) => m.includes('parent pid 12345 is gone'))).toBe(true);
  });

  test('does not exit while the parent stays alive', async () => {
    const isAliveFn = jest.fn(() => true);

    installParentWatcher({
      parentPid: 7777,
      intervalMs: 500,
      isAliveFn,
      exitFn,
      logger,
    });

    await tickIntervals(5, 500);

    expect(isAliveFn.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(exitFn).not.toHaveBeenCalled();
  });

  test('clamps interval below the floor up to MIN', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    installParentWatcher({
      parentPid: 100,
      intervalMs: 50,
      isAliveFn: () => true,
      exitFn,
      logger,
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(500);

    setIntervalSpy.mockRestore();
  });

  test('clamps interval above the ceiling down to MAX', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    installParentWatcher({
      parentPid: 100,
      intervalMs: 999_999,
      isAliveFn: () => true,
      exitFn,
      logger,
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(60_000);

    setIntervalSpy.mockRestore();
  });

  test('uses 2000ms default when intervalMs is omitted', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    installParentWatcher({
      parentPid: 100,
      isAliveFn: () => true,
      exitFn,
      logger,
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(2_000);

    setIntervalSpy.mockRestore();
  });

  test('calls unref() on the timer so it cannot block shutdown', () => {
    // Real timers so the returned handle exposes unref.
    jest.useRealTimers();
    const unrefSpy = jest.fn();
    const fakeTimer = { unref: unrefSpy } as unknown as NodeJS.Timeout;
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(fakeTimer);

    installParentWatcher({
      parentPid: 100,
      intervalMs: 1_000,
      isAliveFn: () => true,
      exitFn,
      logger,
    });

    expect(unrefSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });

  test('handle.stop() cancels the watcher so no further checks happen', async () => {
    const isAliveFn = jest.fn(() => true);

    const handle = installParentWatcher({
      parentPid: 100,
      intervalMs: 500,
      isAliveFn,
      exitFn,
      logger,
    });

    await tickIntervals(2, 500);
    const callsBefore = isAliveFn.mock.calls.length;

    handle.stop();
    await tickIntervals(5, 500);

    expect(isAliveFn.mock.calls.length).toBe(callsBefore);
    expect(exitFn).not.toHaveBeenCalled();
  });

  test('logs and exits exactly once even if multiple ticks observe a dead parent', async () => {
    const isAliveFn = jest.fn(() => false);

    installParentWatcher({
      parentPid: 4242,
      intervalMs: 500,
      isAliveFn,
      exitFn,
      logger,
    });

    await tickIntervals(5, 500);

    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(logs.filter((m) => m.includes('is gone')).length).toBe(1);
  });

  test('stop() prevents exit even if a queued callback observes a dead parent', async () => {
    // Race scenario: stop() runs synchronously and the watcher's `stopped`
    // flag must short-circuit any subsequent callback firing, preventing
    // exit(0) during enhancedShutdown's async cleanup chain.
    let alive = true;
    const isAliveFn = jest.fn(() => alive);

    const handle = installParentWatcher({
      parentPid: 8888,
      intervalMs: 500,
      isAliveFn,
      exitFn,
      logger,
    });

    handle.stop();
    alive = false;
    await tickIntervals(5, 500);

    expect(exitFn).not.toHaveBeenCalled();
  });
});

// Real-path regression guards for issue #644 §7.1: the highest-risk failure
// mode is a false-positive early exit while the parent is still alive. The
// mocked-isAliveFn tests above prove the control flow; these exercise the
// actual defaultIsAlive / process.kill(pid, 0) path end-to-end so a broken
// default implementation cannot pass the suite.
describe('installParentWatcher (real process.kill path)', () => {
  test('does not exit while a real live parent stays alive over multiple ticks', async () => {
    // Use the current test process's pid — guaranteed alive for the duration.
    // MIN clamp (500 ms) × ~5 ticks = ~2.5 s window to catch any spurious fire.
    const exitFn = jest.fn();
    const logger = jest.fn();

    const handle = installParentWatcher({
      parentPid: process.pid,
      intervalMs: 500,
      exitFn,
      logger,
      // isAliveFn intentionally omitted → exercises defaultIsAlive.
    });

    try {
      await new Promise((r) => setTimeout(r, 2_500));
      expect(exitFn).not.toHaveBeenCalled();
      expect(
        (logger.mock.calls as string[][]).filter(([m]) => m.includes('is gone')).length,
      ).toBe(0);
    } finally {
      handle.stop();
    }
  }, 10_000);

  test('exits when the real parent pid is already dead at install time', async () => {
    // Spawn a child that exits immediately, wait for it to be reaped, then
    // install the watcher against its now-dead pid. The first tick must
    // detect death via the real process.kill(pid, 0) throwing ESRCH.
    // Note: PID reuse race is theoretically possible but vanishingly unlikely
    // in the ~600 ms window between the exit event and the first poll on a
    // healthy test host; if this flakes, re-run in isolation.
    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    // Give the OS a beat to reap and free the pid slot for our check.
    await new Promise((r) => setTimeout(r, 100));

    const exitFn = jest.fn();
    const logger = jest.fn();

    const handle = installParentWatcher({
      parentPid: deadPid,
      intervalMs: 500,
      exitFn,
      logger,
    });

    try {
      // First tick arrives after ~500 ms; allow generous slack for CI.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(exitFn).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledWith(0);
      expect(
        (logger.mock.calls as string[][]).some(([m]) =>
          m.includes(`parent pid ${deadPid} is gone`),
        ),
      ).toBe(true);
    } finally {
      handle.stop();
    }
  }, 10_000);
});
