/**
 * Check: orphan-chrome
 * Dry-run of cleanOrphanedChromeProcesses — reports orphans without killing them.
 */

import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';

const DEFAULT_CDP_PORT = 9222;
const PORT_WINDOW_SIZE = 5;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function readChromePid(port: number): number | null {
  const filePath = path.join(os.tmpdir(), `openchrome-chrome-${port}.pid`);
  try {
    const { readFileSync } = require('fs');
    const content = readFileSync(filePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function readServerPids(port: number): number[] {
  const filePath = path.join(os.tmpdir(), `openchrome-${port}.pid`);
  try {
    const { readFileSync } = require('fs');
    const content = readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0)
      .map((l: string) => parseInt(l, 10))
      .filter((p: number) => !isNaN(p) && p > 0)
      .filter((p: number) => isPidAlive(p));
  } catch {
    return [];
  }
}

export const checkOrphanChrome: CheckFn = async () => {
  const basePort = parseInt(process.env.CHROME_PORT ?? String(DEFAULT_CDP_PORT), 10);
  const ports = Array.from({ length: PORT_WINDOW_SIZE }, (_, i) => basePort + i).filter(p => p <= 65535);

  const orphans: number[] = [];
  for (const port of ports) {
    const chromePid = readChromePid(port);
    if (chromePid === null) continue;
    if (!isPidAlive(chromePid)) continue; // stale PID file

    const serverPids = readServerPids(port);
    if (serverPids.length === 0) {
      // Chrome alive but no server managing it
      orphans.push(chromePid);
    }
  }

  if (orphans.length === 0) {
    return {
      id: 'orphan-chrome',
      title: 'Orphaned Chrome processes',
      status: 'ok',
      detail: 'No orphaned openchrome-managed Chrome processes found',
    };
  }

  return {
    id: 'orphan-chrome',
    title: 'Orphaned Chrome processes',
    status: 'warn',
    detail: `Orphaned Chrome PID(s): ${orphans.join(', ')}`,
    remediation: 'Run: openchrome reap  (or use the oc_reap_orphans MCP tool)',
  };
};
