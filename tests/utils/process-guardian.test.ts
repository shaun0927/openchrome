/// <reference types="jest" />
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnProcessGuardian } from '../../src/utils/process-guardian';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Windows CI can spend several seconds on Node cold-start for the detached
// guardian process plus the `taskkill` execSync roundtrip before the child
// exits. Bump the default well past that to prevent spurious timeouts.
async function waitForDead(pid: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for child death');
}

async function rmDirEventually(dir: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastError;
}

describe('spawnProcessGuardian', () => {
  test('kills the child process when the watched parent PID is already gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();

    if (!child.pid) {
      throw new Error('failed to spawn child process');
    }

    spawnProcessGuardian(99999999, child.pid, { label: 'guardian-test', pollMs: 100 });

    await waitForDead(child.pid);
    expect(isAlive(child.pid)).toBe(false);
  }, 20000);

  test('does not delete a pid file that was rewritten for a newer process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();

    if (!child.pid) {
      throw new Error('failed to spawn child process');
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-guardian-'));
    const pidFile = path.join(dir, 'chrome.pid');
    fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

    spawnProcessGuardian(99999999, child.pid, { label: 'guardian-test', pollMs: 200, pidFilePath: pidFile });
    fs.writeFileSync(pidFile, '123456\n', 'utf8');

    await waitForDead(child.pid);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe('123456');
    await rmDirEventually(dir);
  }, 20000);
});
