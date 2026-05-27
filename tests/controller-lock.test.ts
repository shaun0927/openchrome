import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DuplicateControllerError,
  acquireControllerLock,
  controllerLockKey,
  formatDuplicateControllerMessage,
  getControllerLockPath,
  releaseControllerLock,
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
});
