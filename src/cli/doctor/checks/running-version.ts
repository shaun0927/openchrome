/**
 * Check: running-version
 * Installing a new OpenChrome package does not replace a server that is
 * already running: MCP hosts keep talking to the old process until it is
 * restarted and they rediscover tools. Surface the mismatch for every live
 * owner, whatever port or profile it was started with.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';
import { isPidAlive } from '../../../chrome/controller-lock';
import { getVersion } from '../../../core/version';

export interface RunningOwner {
  pid: number;
  version: string;
  port?: number;
}

function lockRoot(rootDir?: string): string {
  return rootDir || process.env.OPENCHROME_CONTROLLER_LOCK_DIR || path.join(os.homedir(), '.openchrome', 'locks');
}

/** Live OpenChrome owners recorded in controller locks. */
export function readRunningOwners(rootDir?: string): RunningOwner[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(lockRoot(rootDir)).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  const owners: RunningOwner[] = [];
  for (const name of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(lockRoot(rootDir), name), 'utf8')) as {
        pid?: unknown; version?: unknown; port?: unknown;
      };
      if (typeof parsed.pid !== 'number' || !isPidAlive(parsed.pid)) continue;
      owners.push({
        pid: parsed.pid,
        version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
        ...(typeof parsed.port === 'number' ? { port: parsed.port } : {}),
      });
    } catch {
      // Unreadable or partially written lock: not evidence of a running owner.
    }
  }
  return owners;
}

export function makeRunningVersionCheck(options: { rootDir?: string; installedVersion?: string } = {}): CheckFn {
  return async () => {
    const installed = options.installedVersion ?? getVersion();
    const owners = readRunningOwners(options.rootDir);
    const stale = owners.filter(owner => owner.version !== installed);

    if (stale.length === 0) {
      return {
        id: 'running-version',
        title: 'Running OpenChrome version',
        status: 'ok',
        detail: owners.length === 0
          ? `No running OpenChrome owner; the next start uses the installed ${installed}`
          : `${owners.length} running owner(s), all on the installed ${installed}`,
      };
    }
    const described = stale
      .map(owner => `pid ${owner.pid}${owner.port !== undefined ? ` (port ${owner.port})` : ''} runs ${owner.version}`)
      .join('; ');
    return {
      id: 'running-version',
      title: 'Running OpenChrome version',
      status: 'warn',
      detail: `${described}, but ${installed} is installed`,
      remediation: 'Restart the MCP host (or run `oc stop`) so it starts the installed version, then let the host reconnect and rediscover tools. Previously held workspaces, tabIds and leases belong to the old process and must be re-acquired; re-check any action whose result was not confirmed instead of replaying it.',
      facts: {
        installedVersion: installed,
        staleOwners: stale.map(owner => ({ pid: owner.pid, runningVersion: owner.version, ...(owner.port !== undefined ? { port: owner.port } : {}) })),
      },
    };
  };
}

export const checkRunningVersion: CheckFn = makeRunningVersionCheck();
