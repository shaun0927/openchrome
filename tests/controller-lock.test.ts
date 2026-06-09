import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DuplicateControllerError,
  acquireControllerLock,
  acquireControllerLockWithHealthCheck,
  controllerLockKey,
  formatDuplicateControllerMessage,
  getControllerLockPath,
  recordControllerHeartbeat,
  releaseControllerLock,
  startControllerHeartbeat,
} from '../src/utils/controller-lock';

describe('controller lock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keys locks by port and normalized user data directory', () => {
    expect(controllerLockKey(9222, '/tmp/example profile')).toContain('port-9222-');
    expect(getControllerLockPath(9222, '/tmp/example profile', tmpDir)).toBe(
      path.join(tmpDir, `${controllerLockKey(9222, '/tmp/example profile')}.json`),
    );
  });

  test('acquires and releases a lock', () => {
    const handle = acquireControllerLock({ port: 9222, userDataDir: path.join(tmpDir, 'profile') }, tmpDir);

    expect(fs.existsSync(handle.path)).toBe(true);
    expect(handle.metadata.port).toBe(9222);

    handle.release();
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test('rejects a second live owner for the same port and profile', () => {
    const profile = path.join(tmpDir, 'profile');
    const first = acquireControllerLock({ port: 9222, userDataDir: profile }, tmpDir);

    expect(() => acquireControllerLock({ port: 9222, userDataDir: profile }, tmpDir)).toThrow(DuplicateControllerError);

    first.release();
  });

  test('allows different ports and profiles', () => {
    const profile = path.join(tmpDir, 'profile');
    const first = acquireControllerLock({ port: 9222, userDataDir: profile }, tmpDir);
    const second = acquireControllerLock({ port: 9223, userDataDir: profile }, tmpDir);
    const third = acquireControllerLock({ port: 9222, userDataDir: path.join(tmpDir, 'other') }, tmpDir);

    expect(fs.existsSync(first.path)).toBe(true);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(fs.existsSync(third.path)).toBe(true);

    first.release();
    second.release();
    third.release();
  });

  test('recovers stale locks for dead pids', () => {
    const profile = path.join(tmpDir, 'profile');
    const lockPath = getControllerLockPath(9222, profile, tmpDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, port: 9222, userDataDir: profile }) + '\n');

    const handle = acquireControllerLock({ port: 9222, userDataDir: profile }, tmpDir);

    expect(handle.metadata.pid).toBe(process.pid);
    handle.release();
  });

  test('release does not remove another process lock', () => {
    const profile = path.join(tmpDir, 'profile');
    const lockPath = getControllerLockPath(9222, profile, tmpDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 12345, port: 9222, userDataDir: profile }) + '\n');

    releaseControllerLock(lockPath, process.pid);

    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test('duplicate error message includes safe remediation', () => {
    const profile = path.join(tmpDir, 'profile');
    const first = acquireControllerLock({ port: 9222, userDataDir: profile, command: ['openchrome', 'serve'] }, tmpDir);

    try {
      acquireControllerLock({ port: 9222, userDataDir: profile }, tmpDir);
      throw new Error('expected duplicate lock');
    } catch (err) {
      const message = formatDuplicateControllerMessage(err as DuplicateControllerError);
      expect(message).toContain('Refusing to start a second direct controller');
      expect(message).toContain('different --port and --user-data-dir');
      expect(message).toContain('--allow-unsafe-shared-attach');
    } finally {
      first.release();
    }
  });

  describe('health-aware acquisition (#1474)', () => {
    const profile = () => path.join(tmpDir, 'profile');

    // Writes a lock owned by a *live* pid (this process) so PID-liveness alone
    // would keep it forever. Guardrail inputs (startedAt/hostname) are explicit.
    function writeOwnerLock(overrides: Record<string, unknown> = {}): string {
      const lockPath = getControllerLockPath(9222, profile(), tmpDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          port: 9222,
          userDataDir: path.resolve(profile()),
          startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          hostname: os.hostname(),
          ...overrides,
        }) + '\n',
      );
      return lockPath;
    }

    const opts = (over: Record<string, unknown> = {}) => ({
      graceMs: 15_000,
      probeAttempts: 2,
      probeIntervalMs: 0,
      ...over,
    });

    test('takes over a half-zombie owner whose CDP is unreachable', async () => {
      const lockPath = writeOwnerLock();
      const probe = jest.fn(async () => false);

      const handle = await acquireControllerLockWithHealthCheck(
        { port: 9222, userDataDir: profile() },
        tmpDir,
        opts({ probe }),
      );

      expect(probe).toHaveBeenCalledWith(9222);
      expect(handle.metadata.pid).toBe(process.pid);
      expect(fs.existsSync(lockPath)).toBe(true);
      handle.release();
    });

    test('never evicts a healthy owner (CDP reachable)', async () => {
      const first = acquireControllerLock({ port: 9222, userDataDir: profile() }, tmpDir);
      const probe = jest.fn(async () => true);

      await expect(
        acquireControllerLockWithHealthCheck({ port: 9222, userDataDir: profile() }, tmpDir, opts({ probe })),
      ).rejects.toBeInstanceOf(DuplicateControllerError);

      first.release();
    });

    test('does not take over within the boot grace period', async () => {
      writeOwnerLock({ startedAt: new Date().toISOString() });
      const probe = jest.fn(async () => false);

      await expect(
        acquireControllerLockWithHealthCheck({ port: 9222, userDataDir: profile() }, tmpDir, opts({ probe })),
      ).rejects.toBeInstanceOf(DuplicateControllerError);
      // Grace short-circuits before any probe runs.
      expect(probe).not.toHaveBeenCalled();
    });

    test('default grace derives from the Chrome launch budget — does not evict a still-launching owner', async () => {
      // 45s old: past the previous 15s default, but well within the 60s Chrome
      // launch budget during which CDP is legitimately not yet listening.
      writeOwnerLock({ startedAt: new Date(Date.now() - 45_000).toISOString() });
      const probe = jest.fn(async () => false);

      await expect(
        // No graceMs override → exercises the launch-budget-derived default.
        acquireControllerLockWithHealthCheck(
          { port: 9222, userDataDir: profile() },
          tmpDir,
          { probe, probeAttempts: 2, probeIntervalMs: 0 },
        ),
      ).rejects.toBeInstanceOf(DuplicateControllerError);
      expect(probe).not.toHaveBeenCalled(); // grace short-circuits before probing
    });

    test('never evicts an owner registered on a different host', async () => {
      writeOwnerLock({ hostname: `${os.hostname()}-other` });
      const probe = jest.fn(async () => false);

      await expect(
        acquireControllerLockWithHealthCheck({ port: 9222, userDataDir: profile() }, tmpDir, opts({ probe })),
      ).rejects.toBeInstanceOf(DuplicateControllerError);
      expect(probe).not.toHaveBeenCalled();
    });

    test('escape hatch (disabled) preserves legacy reject-on-live-owner', async () => {
      writeOwnerLock();
      const probe = jest.fn(async () => false);

      await expect(
        acquireControllerLockWithHealthCheck(
          { port: 9222, userDataDir: profile() },
          tmpDir,
          opts({ probe, disabled: true }),
        ),
      ).rejects.toBeInstanceOf(DuplicateControllerError);
      expect(probe).not.toHaveBeenCalled();
    });

    test('does NOT take over a long-lived owner that is mid-relaunch (recent heartbeat)', async () => {
      // The owner started long ago (past the grace) but refreshed its heartbeat
      // 1s ago — i.e. its Chrome was healthy a moment before this crash/relaunch
      // window. Its CDP is momentarily unreachable, but it must NOT be evicted,
      // or two controllers would own the same port/profile (the #1474 P1 gap).
      writeOwnerLock({
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
      });
      const probe = jest.fn(async () => false);

      await expect(
        acquireControllerLockWithHealthCheck({ port: 9222, userDataDir: profile() }, tmpDir, opts({ probe })),
      ).rejects.toBeInstanceOf(DuplicateControllerError);
      expect(probe).not.toHaveBeenCalled(); // recent heartbeat short-circuits before probing
    });

    test('DOES take over when the heartbeat is stale beyond the grace (true half-zombie)', async () => {
      writeOwnerLock({
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        lastHeartbeatAt: new Date(Date.now() - 5 * 60_000).toISOString(), // stale > grace
      });
      const probe = jest.fn(async () => false);

      const handle = await acquireControllerLockWithHealthCheck(
        { port: 9222, userDataDir: profile() },
        tmpDir,
        opts({ probe }),
      );
      expect(handle.metadata.pid).toBe(process.pid);
      handle.release();
    });

    test('recordControllerHeartbeat refreshes lastHeartbeatAt only for the owning pid', () => {
      const handle = acquireControllerLock({ port: 9222, userDataDir: profile() }, tmpDir);
      const before = handle.metadata.lastHeartbeatAt;

      recordControllerHeartbeat(handle.path, handle.metadata.pid, () => Date.parse(before) + 60_000);
      const afterOwn = JSON.parse(fs.readFileSync(handle.path, 'utf8'));
      expect(afterOwn.lastHeartbeatAt).not.toBe(before);

      // A different pid must not be able to refresh (or resurrect) the lock.
      recordControllerHeartbeat(handle.path, handle.metadata.pid + 1, () => Date.parse(before) + 120_000);
      const afterOther = JSON.parse(fs.readFileSync(handle.path, 'utf8'));
      expect(afterOther.lastHeartbeatAt).toBe(afterOwn.lastHeartbeatAt);

      handle.release();
    });

    test('recordControllerHeartbeat ignores malformed lock content even when pid matches', () => {
      const lockPath = writeOwnerLock({ pid: 111, port: undefined });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 111, userDataDir: path.resolve(profile()) }) + '\n');

      recordControllerHeartbeat(lockPath, 111, () => Date.parse('2026-01-01T00:02:00.000Z'));

      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(current.lastHeartbeatAt).toBeUndefined();
      expect(current.port).toBeUndefined();
    });

    test('startControllerHeartbeat refreshes the lock while the probe reports healthy', async () => {
      jest.useFakeTimers();
      try {
        const handle = acquireControllerLock({ port: 9222, userDataDir: profile() }, tmpDir);
        const before = JSON.parse(fs.readFileSync(handle.path, 'utf8')).lastHeartbeatAt;
        let clock = Date.parse(before);

        const hb = startControllerHeartbeat(handle, async () => true, {
          intervalMs: 1000,
          nowFn: () => (clock += 60_000),
        });
        await jest.advanceTimersByTimeAsync(1000); // fire one tick + flush probe/record
        hb.stop();

        const after = JSON.parse(fs.readFileSync(handle.path, 'utf8')).lastHeartbeatAt;
        expect(after).not.toBe(before);
        handle.release();
      } finally {
        jest.useRealTimers();
      }
    });

    test('still recovers a plain dead-pid stale lock without probing', async () => {
      const lockPath = getControllerLockPath(9222, profile(), tmpDir);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, port: 9222, userDataDir: profile() }) + '\n');
      const probe = jest.fn(async () => false);

      const handle = await acquireControllerLockWithHealthCheck(
        { port: 9222, userDataDir: profile() },
        tmpDir,
        opts({ probe }),
      );

      expect(handle.metadata.pid).toBe(process.pid);
      expect(probe).not.toHaveBeenCalled();
      handle.release();
    });
  });
});
