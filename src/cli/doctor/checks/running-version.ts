/**
 * Check: running-version
 * Installing a new OpenChrome package does not replace a server that is
 * already running: MCP hosts keep talking to the old process until it is
 * restarted and they rediscover tools. Surface the mismatch.
 */

import * as fs from 'fs';
import type { CheckFn } from '../../doctor';
import { getControllerLockPath, isPidAlive, normalizeControllerUserDataDir } from '../../../chrome/controller-lock';
import { ProfileManager } from '../../../chrome/profile-manager';
import { getVersion } from '../../../core/version';

const DEFAULT_PORT = 9222;

export interface RunningOwner {
  pid: number;
  version: string;
}

/** The live OpenChrome owner for a port/profile, if any. */
export function readRunningOwner(port: number, userDataDir: string, rootDir?: string): RunningOwner | null {
  try {
    const raw = fs.readFileSync(getControllerLockPath(port, normalizeControllerUserDataDir(userDataDir), rootDir), 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown; version?: unknown };
    if (typeof parsed.pid !== 'number' || !isPidAlive(parsed.pid)) return null;
    return { pid: parsed.pid, version: typeof parsed.version === 'string' ? parsed.version : 'unknown' };
  } catch {
    return null;
  }
}

export function makeRunningVersionCheck(options: {
  port?: number;
  userDataDir?: string;
  rootDir?: string;
  installedVersion?: string;
} = {}): CheckFn {
  return async () => {
    const port = options.port ?? parseInt(process.env.CHROME_PORT ?? String(DEFAULT_PORT), 10);
    const userDataDir = options.userDataDir
      ?? process.env.CHROME_USER_DATA_DIR
      ?? process.env.OPENCHROME_USER_DATA_DIR
      ?? ProfileManager.PERSISTENT_PROFILE_DIR;
    const installed = options.installedVersion ?? getVersion();
    const owner = readRunningOwner(port, userDataDir, options.rootDir);

    if (!owner) {
      return {
        id: 'running-version',
        title: 'Running OpenChrome version',
        status: 'ok',
        detail: `No running OpenChrome owner for port ${port}; the next start uses the installed ${installed}`,
      };
    }
    if (owner.version === installed) {
      return {
        id: 'running-version',
        title: 'Running OpenChrome version',
        status: 'ok',
        detail: `Running owner pid ${owner.pid} is the installed ${installed}`,
      };
    }
    return {
      id: 'running-version',
      title: 'Running OpenChrome version',
      status: 'warn',
      detail: `Running owner pid ${owner.pid} is ${owner.version}, but ${installed} is installed`,
      remediation: 'Restart the MCP host (or run `oc stop`) so it starts the installed version, then let the host reconnect and rediscover tools. Previously held workspaces, tabIds and leases belong to the old process and must be re-acquired; re-check any action whose result was not confirmed instead of replaying it.',
      facts: { port, ownerPid: owner.pid, runningVersion: owner.version, installedVersion: installed },
    };
  };
}

export const checkRunningVersion: CheckFn = makeRunningVersionCheck();
