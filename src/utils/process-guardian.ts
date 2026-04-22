import { spawn } from 'child_process';
import * as path from 'path';

function escapeForJsString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Spawn a detached watchdog that kills `childPid` when `parentPid` disappears.
 * This is used for abrupt parent death (e.g. SIGKILL) where the main process
 * cannot run any shutdown hooks.
 */
export function spawnProcessGuardian(
  parentPid: number,
  childPid: number,
  options?: { pidFilePath?: string; label?: string; pollMs?: number },
): void {
  const pidFilePath = options?.pidFilePath ? escapeForJsString(path.resolve(options.pidFilePath)) : '';
  const label = escapeForJsString(options?.label ?? 'process');
  const pollMs = Math.max(100, options?.pollMs ?? 500);

  const script = `
    const { execSync } = require('child_process');
    const fs = require('fs');
    const parentPid = ${parentPid};
    const childPid = ${childPid};
    const pollMs = ${pollMs};
    const pidFilePath = '${pidFilePath}';
    const label = '${label}';

    function isAlive(pid) {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }

    function removePidFile() {
      if (!pidFilePath) return;
      try { fs.unlinkSync(pidFilePath); } catch {}
    }

    function killTree(pid, signal = 'SIGTERM') {
      if (process.platform === 'win32') {
        try {
          execSync(\`taskkill /T /F /PID \${pid}\`, { stdio: 'ignore' });
        } catch {}
        return;
      }
      try { process.kill(-pid, signal); } catch {}
      try { process.kill(pid, signal); } catch {}
    }

    const timer = setInterval(() => {
      if (!isAlive(childPid)) {
        removePidFile();
        clearInterval(timer);
        process.exit(0);
      }
      if (isAlive(parentPid)) return;

      killTree(childPid, 'SIGTERM');
      setTimeout(() => {
        if (isAlive(childPid)) {
          killTree(childPid, 'SIGKILL');
        }
        removePidFile();
        clearInterval(timer);
        process.exit(0);
      }, 500);
    }, pollMs);
  `;

  const guardian = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  guardian.unref();
}
