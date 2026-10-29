/**
 * Cross-process user registry for OpenChrome-managed profile Chromes.
 *
 * A profile Chrome (`~/.openchrome/profiles/<dir>`) launched by one MCP
 * session can be reused by another. Each session that uses it drops a
 * `<userDataDir>/.openchrome-users/<pid>` marker; whoever leaves last closes
 * the Chrome, so the launching session never kills a browser another session
 * is still driving, and an attaching session never leaks one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isPidAlive } from './controller-lock';

const USERS_DIRNAME = '.openchrome-users';

function usersDir(userDataDir: string): string {
  return path.join(userDataDir, USERS_DIRNAME);
}

export function registerProfileUser(userDataDir: string, pid: number = process.pid): void {
  try {
    fs.mkdirSync(usersDir(userDataDir), { recursive: true });
    fs.writeFileSync(path.join(usersDir(userDataDir), String(pid)), String(Date.now()));
  } catch (err) {
    console.error(`[ProfileUsers] Failed to register user ${pid} for ${userDataDir}:`, err);
  }
}

/** Live users other than `pid`; dead entries are pruned along the way. */
export function listOtherProfileUsers(userDataDir: string, pid: number = process.pid): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(usersDir(userDataDir));
  } catch {
    return [];
  }
  const others: number[] = [];
  for (const entry of entries) {
    const other = Number(entry);
    if (!Number.isSafeInteger(other) || other === pid) continue;
    if (isPidAlive(other)) {
      others.push(other);
    } else {
      try { fs.unlinkSync(path.join(usersDir(userDataDir), entry)); } catch { /* raced */ }
    }
  }
  return others;
}

/**
 * Remove this process's marker. Returns true when this was the last live
 * user, i.e. the caller is now responsible for closing the Chrome.
 */
export function releaseProfileUser(userDataDir: string, pid: number = process.pid): boolean {
  try { fs.unlinkSync(path.join(usersDir(userDataDir), String(pid))); } catch { /* not registered */ }
  return listOtherProfileUsers(userDataDir, pid).length === 0;
}

export function hasLiveProfileUsers(userDataDir: string): boolean {
  return listOtherProfileUsers(userDataDir, -1).length > 0;
}

/** Debug port Chrome advertises in `<userDataDir>/DevToolsActivePort`, if any. */
export function readDevToolsActivePort(userDataDir: string): number | null {
  try {
    const first = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0].trim();
    if (!/^\d+$/.test(first)) return null;
    const port = parseInt(first, 10);
    return port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** Chrome's PID from the `SingletonLock` symlink (`<hostname>-<pid>`), POSIX only. */
export function readSingletonLockPid(userDataDir: string): number | null {
  try {
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const match = /-(\d+)$/.exec(target);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}
