import { EventEmitter } from 'events';
import {
  DEFAULT_RELEASE_FAILURE_THRESHOLD,
  OWNER_SELF_RELEASE_EXIT_CODE,
  wireOwnerSelfRelease,
} from '../src/chrome/owner-self-release';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('owner self-release (#1474)', () => {
  function setup(over: {
    releaseLock?: () => void;
    probeChromeReachable?: () => Promise<boolean>;
    failureThreshold?: number;
  } = {}) {
    const watchdog = new EventEmitter();
    const releaseLock = over.releaseLock ?? jest.fn();
    const exit = jest.fn();
    const log = jest.fn();
    const probeChromeReachable = over.probeChromeReachable ?? jest.fn(async () => false);
    wireOwnerSelfRelease(watchdog, {
      releaseLock,
      exit,
      log,
      probeChromeReachable,
      failureThreshold: over.failureThreshold,
    });
    return { watchdog, releaseLock, exit, log, probeChromeReachable };
  }

  test('releases + exits after threshold consecutive failures with CDP unreachable', async () => {
    const { watchdog, releaseLock, exit, probeChromeReachable } = setup();

    for (let i = 0; i < DEFAULT_RELEASE_FAILURE_THRESHOLD; i++) {
      watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    }
    await flush();

    expect(probeChromeReachable).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(OWNER_SELF_RELEASE_EXIT_CODE);
    expect(OWNER_SELF_RELEASE_EXIT_CODE).not.toBe(0);
  });

  test('does NOT tear down a Chrome that is actually reachable (Codex P2)', async () => {
    const { watchdog, releaseLock, exit } = setup({ probeChromeReachable: jest.fn(async () => true) });

    for (let i = 0; i < DEFAULT_RELEASE_FAILURE_THRESHOLD; i++) {
      watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    }
    await flush();

    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('watchdog-exhausted (emitted after a SUCCESSFUL relaunch) never self-releases', async () => {
    const { watchdog, releaseLock, exit, probeChromeReachable } = setup();

    watchdog.emit('watchdog-exhausted', { count: 10, timestamp: 0 });
    await flush();

    expect(probeChromeReachable).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('a single transient relaunch-failed does not act (below threshold)', async () => {
    const { watchdog, releaseLock, exit, probeChromeReachable } = setup({ failureThreshold: 2 });

    watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    await flush();

    expect(probeChromeReachable).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('a successful relaunch between failures resets the counter', async () => {
    const { watchdog, releaseLock, exit } = setup({ failureThreshold: 2 });

    watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    watchdog.emit('chrome-relaunched', { pid: 1, timestamp: 0 }); // recovery → reset
    watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    await flush();

    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('does NOT surrender ownership on a recoverable chrome-died', async () => {
    const { watchdog, releaseLock, exit } = setup();

    watchdog.emit('chrome-died', { pid: 123, timestamp: 0 });
    await flush();

    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('stays up when the reachability probe itself errors (inconclusive)', async () => {
    const probeChromeReachable = jest.fn(async () => {
      throw new Error('probe exploded');
    });
    const { watchdog, releaseLock, exit, log } = setup({ probeChromeReachable });

    for (let i = 0; i < DEFAULT_RELEASE_FAILURE_THRESHOLD; i++) {
      watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    }
    await flush();

    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('probe errored'));
  });

  test('still exits even if lock release throws (best-effort)', async () => {
    const releaseLock = jest.fn(() => {
      throw new Error('unlink failed');
    });
    const { watchdog, exit, log } = setup({ releaseLock });

    for (let i = 0; i < DEFAULT_RELEASE_FAILURE_THRESHOLD; i++) {
      watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });
    }
    await flush();

    expect(exit).toHaveBeenCalledWith(OWNER_SELF_RELEASE_EXIT_CODE);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('release failed'));
  });
});
