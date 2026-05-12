/**
 * Check: profile-lock
 * Detects if the configured Chrome user-data-dir is locked by a running Chrome.
 * Looks for SingletonLock / SingletonCookie files in the profile directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CheckFn } from '../../doctor';

function getDefaultProfileDir(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  } else {
    return path.join(os.homedir(), '.config', 'google-chrome');
  }
}

export const checkProfileLock: CheckFn = async () => {
  const profileDir = process.env.OPENCHROME_USER_DATA_DIR ?? getDefaultProfileDir();

  if (!fs.existsSync(profileDir)) {
    return {
      id: 'profile-lock',
      title: 'Chrome profile lock',
      status: 'ok',
      detail: `Profile directory not found at ${profileDir} (no lock possible)`,
    };
  }

  const lockFiles = ['SingletonLock', 'SingletonCookie'];
  const found: string[] = [];

  for (const lockFile of lockFiles) {
    const lockPath = path.join(profileDir, lockFile);
    try {
      // Use lstatSync to avoid following symlinks — SingletonLock is typically a symlink
      fs.lstatSync(lockPath);
      found.push(lockFile);
    } catch {
      // File doesn't exist — no lock
    }
  }

  if (found.length === 0) {
    return {
      id: 'profile-lock',
      title: 'Chrome profile lock',
      status: 'ok',
      detail: `No lock files in ${profileDir}`,
    };
  }

  return {
    id: 'profile-lock',
    title: 'Chrome profile lock',
    status: 'warn',
    detail: `Lock file(s) found: ${found.join(', ')} in ${profileDir}`,
    remediation: 'Close all Chrome windows using this profile, or use --user-data-dir to point to a separate profile',
  };
};
