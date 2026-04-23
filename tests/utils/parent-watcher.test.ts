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
});
