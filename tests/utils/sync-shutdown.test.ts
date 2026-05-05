import {
  shutdownSyncBestEffort,
  registerManagedChrome,
  unregisterManagedChrome,
  listRegisteredManagedChromes,
  _resetForTesting,
} from '../../src/utils/sync-shutdown';

jest.mock('../../src/utils/pid-manager', () => {
  const actual = jest.requireActual('../../src/utils/pid-manager');
  return {
    ...actual,
    killProcessTree: jest.fn(),
  };
});

import { killProcessTree } from '../../src/utils/pid-manager';

describe('sync-shutdown (#661 Phase 2)', () => {
  beforeEach(() => {
    _resetForTesting();
    (killProcessTree as jest.Mock).mockClear();
    delete process.env.OPENCHROME_KILL_ON_EXIT;
  });

  it('register / unregister maintains a deduped list', () => {
    registerManagedChrome({ pid: 100 });
    registerManagedChrome({ pid: 100, userDataDir: '/tmp/x' }); // replace
    registerManagedChrome({ pid: 200 });
    expect(listRegisteredManagedChromes().map((e) => e.pid).sort()).toEqual([100, 200]);

    unregisterManagedChrome(100);
    expect(listRegisteredManagedChromes().map((e) => e.pid)).toEqual([200]);
  });

  it('rejects non-positive pids', () => {
    registerManagedChrome({ pid: 0 });
    registerManagedChrome({ pid: -1 });
    registerManagedChrome({ pid: NaN });
    expect(listRegisteredManagedChromes()).toHaveLength(0);
  });

  it('shutdownSyncBestEffort kills registered Chromes (force=true)', () => {
    registerManagedChrome({ pid: 12345 });
    registerManagedChrome({ pid: 67890, userDataDir: '/tmp/profile' });

    shutdownSyncBestEffort({ force: true });

    // SIGTERM + SIGKILL for each pid
    const calls = (killProcessTree as jest.Mock).mock.calls;
    expect(calls.filter((c) => c[1] === 'SIGTERM').map((c) => c[0]).sort()).toEqual([12345, 67890]);
    expect(calls.filter((c) => c[1] === 'SIGKILL').map((c) => c[0]).sort()).toEqual([12345, 67890]);
  });

  it('is idempotent', () => {
    registerManagedChrome({ pid: 1 });
    shutdownSyncBestEffort({ force: true });
    const firstCallCount = (killProcessTree as jest.Mock).mock.calls.length;
    shutdownSyncBestEffort({ force: true });
    expect((killProcessTree as jest.Mock).mock.calls.length).toBe(firstCallCount);
  });

  it('respects OPENCHROME_KILL_ON_EXIT=never (without force)', () => {
    process.env.OPENCHROME_KILL_ON_EXIT = 'never';
    registerManagedChrome({ pid: 1 });
    shutdownSyncBestEffort();
    expect((killProcessTree as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('honors a custom lookup function', () => {
    shutdownSyncBestEffort({
      force: true,
      lookup: () => [{ pid: 7777 }, { pid: 8888 }],
    });
    const sigterms = (killProcessTree as jest.Mock).mock.calls
      .filter((c) => c[1] === 'SIGTERM')
      .map((c) => c[0])
      .sort();
    expect(sigterms).toEqual([7777, 8888]);
  });
});
