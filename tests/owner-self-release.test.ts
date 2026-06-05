import { EventEmitter } from 'events';
import {
  OWNER_SELF_RELEASE_EXIT_CODE,
  wireOwnerSelfRelease,
} from '../src/chrome/owner-self-release';

describe('owner self-release (#1474)', () => {
  function setup(over: { releaseLock?: () => void } = {}) {
    const watchdog = new EventEmitter();
    const releaseLock = over.releaseLock ?? jest.fn();
    const exit = jest.fn();
    const log = jest.fn();
    wireOwnerSelfRelease(watchdog, { releaseLock, exit, log });
    return { watchdog, releaseLock, exit, log };
  }

  test('releases the lock and exits non-zero when the watchdog is exhausted', () => {
    const { watchdog, releaseLock, exit } = setup();

    watchdog.emit('watchdog-exhausted', { count: 10, timestamp: 0 });

    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(OWNER_SELF_RELEASE_EXIT_CODE);
    expect(OWNER_SELF_RELEASE_EXIT_CODE).not.toBe(0);
  });

  test('does NOT surrender ownership on a recoverable chrome-died', () => {
    const { watchdog, releaseLock, exit } = setup();

    watchdog.emit('chrome-died', { pid: 123, timestamp: 0 });

    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('does NOT surrender ownership on a single transient relaunch-failed', () => {
    const { watchdog, releaseLock, exit } = setup();

    watchdog.emit('relaunch-failed', { error: new Error('boom'), timestamp: 0 });

    expect(releaseLock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test('still exits even if lock release throws (best-effort)', () => {
    const releaseLock = jest.fn(() => {
      throw new Error('unlink failed');
    });
    const { watchdog, exit, log } = setup({ releaseLock });

    watchdog.emit('watchdog-exhausted', { count: 10, timestamp: 0 });

    expect(exit).toHaveBeenCalledWith(OWNER_SELF_RELEASE_EXIT_CODE);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('release failed'));
  });
});
