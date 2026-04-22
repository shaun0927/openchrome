/// <reference types="jest" />
import { spawn } from 'child_process';
import { spawnProcessGuardian } from '../../src/utils/process-guardian';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for child death');
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
  });
});
