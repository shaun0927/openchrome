import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CuratorLock } from '../../../src/pilot/curator/lock';

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

  test('a second instance fails to acquire while first still holds', () => {
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

  test('acquire is idempotent on the same instance', () => {
    const lock = new CuratorLock({ rootDir: root });
    expect(lock.acquire()).toBe(true);
    expect(lock.acquire()).toBe(true); // second call returns true without error
    lock.release();
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
    const lockPath = path.join(root, 'lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 0xfffffe, start_ts: Date.now() }));
    const lock = new CuratorLock({ rootDir: root, isAlive: () => false });
    expect(lock.acquire()).toBe(true);
    expect(lock.readHolder()?.pid).toBe(process.pid);
    lock.release();
  });

  test('reclaims when lockfile mtime is older than ttl, even if isAlive says true', () => {
    const lockPath = path.join(root, 'lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, start_ts: 0 }));
    // Wind mtime 1 h + 1 min into the past.
    const ancient = new Date(Date.now() - (60 * 60 * 1_000 + 60 * 1_000));
    fs.utimesSync(lockPath, ancient, ancient);

    const lock = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  test('does NOT reclaim when holder is alive and within ttl', () => {
    const lockPath = path.join(root, 'lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, start_ts: Date.now() }));
    const lock = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(lock.acquire()).toBe(false);
  });

  test('reclaims when lockfile is malformed (not JSON)', () => {
    const lockPath = path.join(root, 'lock');
    fs.writeFileSync(lockPath, 'not-json');
    const lock = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  test('reclaims when lockfile has no pid field', () => {
    const lockPath = path.join(root, 'lock');
    fs.writeFileSync(lockPath, JSON.stringify({ start_ts: Date.now() }));
    const lock = new CuratorLock({ rootDir: root, isAlive: () => true });
    expect(lock.acquire()).toBe(true);
    lock.release();
  });
});

describe('CuratorLock — readHolder', () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns null when no lock file exists', () => {
    const lock = new CuratorLock({ rootDir: root });
    expect(lock.readHolder()).toBeNull();
  });

  test('returns pid and start_ts after acquire', () => {
    const before = Date.now();
    const lock = new CuratorLock({ rootDir: root });
    lock.acquire();
    const holder = lock.readHolder();
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.start_ts).toBeGreaterThanOrEqual(before);
    lock.release();
  });
});
