/**
 * Check: pid-lock
 * Verifies the openchrome PID file is absent or owned by a live process.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';

const DEFAULT_CDP_PORT = 9222;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

export const checkPidLock: CheckFn = async () => {
  const port = parseInt(process.env.CHROME_PORT ?? String(DEFAULT_CDP_PORT), 10);
  const pidFilePath = path.join(os.tmpdir(), `openchrome-${port}.pid`);

  if (!fs.existsSync(pidFilePath)) {
    return {
      id: 'pid-lock',
      title: 'PID lock file',
      status: 'ok',
      detail: `No PID file at ${pidFilePath}`,
    };
  }

  let pids: number[] = [];
  try {
    const content = fs.readFileSync(pidFilePath, 'utf8');
    pids = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => parseInt(l, 10))
      .filter(p => !isNaN(p) && p > 0);
  } catch {
    return {
      id: 'pid-lock',
      title: 'PID lock file',
      status: 'warn',
      detail: `PID file exists at ${pidFilePath} but could not be read`,
      remediation: `Remove stale lock: rm ${pidFilePath}`,
    };
  }

  if (pids.length === 0) {
    return {
      id: 'pid-lock',
      title: 'PID lock file',
      status: 'warn',
      detail: `PID file at ${pidFilePath} is empty`,
      remediation: `Remove stale lock: rm ${pidFilePath}`,
    };
  }

  const alivePids = pids.filter(pid => isPidAlive(pid));
  if (alivePids.length > 0) {
    return {
      id: 'pid-lock',
      title: 'PID lock file',
      status: 'ok',
      detail: `Active PID(s): ${alivePids.join(', ')} in ${pidFilePath}`,
    };
  }

  return {
    id: 'pid-lock',
    title: 'PID lock file',
    status: 'fail',
    detail: `Stale PID(s) ${pids.join(', ')} in ${pidFilePath} (no live process)`,
    remediation: `Remove stale lock: rm ${pidFilePath}  (or run: openchrome reap)`,
  };
};
