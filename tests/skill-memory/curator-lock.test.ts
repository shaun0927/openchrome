import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CuratorLock } from '../../src/skill-memory/curator-lock';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cur-lock-'));
}

describe('CuratorLock — basic acquire/release', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('acquire on a fresh root succeeds and writes a lockfile', () => {
    const lock = new CuratorLock({ rootDir: root });
    expect(lock.acquire()).toBe(true);
    expect(fs.existsSync(path.join(root, 'lock'))).toBe(true);
    const holder = lock.readHolder();
    expect(holder?.pid).toBe(process.pid);
    lock.release();
  });

  test('release removes the lockfile when we still hold it', () => {
    const lock = new CuratorLock({ rootDir: root });
    lock.acquire();
    lock.release();
    expect(fs.existsSync(path.join(root, 'lock'))).toBe(false);
  });

  test('a second instance fails to acquire while we still hold', () => {
    const a = new CuratorLock({ rootDir: root });
    const b = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    a.release();
  });

  test('reusing a released instance throws', () => {
    const lock = new CuratorLock({ rootDir: root });
    lock.acquire();
    lock.release();
    expect(() => lock.acquire()).toThrow(/cannot reuse/);
  });
});

describe('CuratorLock — stale reclamation', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reclaims when prior holder PID is dead', () => {
    // Plant a lockfile pointing at a PID that does not exist on this
    // OS. Process IDs are 1..2^22, so 0xFFFFFE (16777214) is reliably
    // a dead PID — `kill(0)` will fail with ESRCH.
    const path0 = path.join(root, 'lock');
    fs.writeFileSync(path0, JSON.stringify({ pid: 0xfffffe, start_ts: Date.now() }));
    const lock = new CuratorLock({ rootDir: root, isAlive: () => false });
    expect(lock.acquire()).toBe(true);
    expect(lock.readHolder()?.pid).toBe(process.pid);
    lock.release();
  });

  test('reclaims when lockfile is older than ttl, even if holder is alive', () => {
    const path0 = path.join(root, 'lock');
    fs.writeFileSync(path0, JSON.stringify({ pid: process.pid, start_ts: 0 }));
    // Set mtime far in the past — 1 hour + 1 minute ago.
    const ancient = new Date(Date.now() - (60 * 60 * 1000 + 60 * 1000));
    fs.utimesSync(path0, ancient, ancient);

    const lock = new CuratorLock({
      rootDir: root,
      isAlive: () => true,
    });
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  test('does NOT reclaim when holder is alive and within ttl', () => {
    const path0 = path.join(root, 'lock');
    fs.writeFileSync(path0, JSON.stringify({ pid: process.pid + 1, start_ts: Date.now() }));
    const lock = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(lock.acquire()).toBe(false);
  });

  test('reclaims when lockfile is malformed (no PID)', () => {
    const path0 = path.join(root, 'lock');
    fs.writeFileSync(path0, 'not json');
    const lock = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  test('stale-lock race: second acquire loses when a different PID wins the rename', () => {
    // Simulate two processes that both passed shouldReclaim() and are about
    // to forceWrite(). We do this by monkey-patching: after the first
    // process writes its PID via forceWrite(), a "rival" synchronously
    // overwrites the lock file with a different PID before the ownership
    // verification re-read occurs.
    //
    // We achieve this by subclassing CuratorLock to intercept forceWrite
    // via a spy that overwrites the lock with a foreign PID immediately
    // after the rename. The verify re-read then sees the foreign PID and
    // returns false — proving the post-write ownership check works.
    const lockPath = path.join(root, 'lock');
    const foreignPid = process.pid + 9999;

    // Plant a dead stale lock so shouldReclaim() returns true.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 0xfffffe, start_ts: 0 }));

    // Build a lock instance and intercept forceWrite by replacing the
    // file after it runs (simulating the rival winning the rename race).
    const lock = new CuratorLock({ rootDir: root, isAlive: () => false });

    // Spy: after forceWrite renames our temp file into place, another
    // process immediately renames its own content over the lock.
    const origForceWrite = (lock as unknown as { forceWrite: () => void }).forceWrite.bind(lock);
    (lock as unknown as { forceWrite: () => void }).forceWrite = () => {
      origForceWrite();
      // Rival overwrites synchronously — simulates losing the rename race.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: foreignPid, start_ts: Date.now() }));
    };

    const result = lock.acquire();
    // Our PID is not in the file — must return false.
    expect(result).toBe(false);
    // Confirm the lock really does contain the foreign PID (sanity check).
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    expect(onDisk.pid).toBe(foreignPid);
  });
});
