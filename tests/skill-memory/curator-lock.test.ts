import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

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

  test('stale-lock race: only one process acquires after reclaim', async () => {
    const lockPath = path.join(root, 'lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 0xfffffe, start_ts: 0 }));

    const script = `
      const { CuratorLock } = require('./src/skill-memory/curator-lock');
      const [root] = process.argv.slice(1);
      const lock = new CuratorLock({ rootDir: root, isAlive: (pid) => pid !== 0xfffffe });
      const acquired = lock.acquire();
      if (acquired) {
        const shared = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(shared), 0, 0, 1000);
        lock.release();
      }
      process.stdout.write(acquired ? '1' : '0');
    `;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script, root], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr || `child exited ${code}`));
          });
        }),
      ),
    );

    expect(results.filter((r) => r === '1')).toHaveLength(1);
  });
});
