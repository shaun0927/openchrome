/**
 * Check: disk-space
 * Verifies free space on the ~/.openchrome/ filesystem is >= 500 MB.
 * Supports OPENCHROME_DOCTOR_FAKE_FREE_MB for test injection (non-production only).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { CheckFn } from '../../doctor';

const WARN_THRESHOLD_MB = 500;
const FAIL_THRESHOLD_MB = 100;

function getFreeSpaceMb(dirPath: string): number | null {
  // Test injection: allow faking free space for CI/unit testing
  if (process.env.NODE_ENV !== 'production' && process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB) {
    const fake = parseInt(process.env.OPENCHROME_DOCTOR_FAKE_FREE_MB, 10);
    if (!isNaN(fake)) return fake;
  }

  try {
    const stat = (fs as unknown as { statfsSync?: (path: string) => { bsize: number; bavail: number } }).statfsSync;
    if (stat) {
      const info = stat(dirPath);
      return Math.floor((info.bsize * info.bavail) / (1024 * 1024));
    }
  } catch {
    // statfsSync not available on older Node or the dir doesn't exist
  }

  // Fallback: use df command on Unix. Pass the dirPath as an *argument* via
  // execFileSync — never interpolate it into a shell string — because the
  // home directory can legitimately contain spaces, dollar signs, or other
  // shell metacharacters that would otherwise be interpreted (Gemini
  // security-high). execFileSync invokes `df` directly without spawning a
  // shell, so the argument is passed as-is.
  if (process.platform !== 'win32') {
    try {
      const output = execFileSync('df', ['-m', dirPath], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const lines = output.trim().split('\n');
      const dataLine = lines[lines.length - 1];
      const parts = dataLine.trim().split(/\s+/);
      // df -m: Filesystem 1M-blocks Used Available Use% Mounted
      const available = parseInt(parts[3], 10);
      if (!isNaN(available)) return available;
    } catch {
      // Ignore
    }
  }

  return null;
}

export const checkDiskSpace: CheckFn = async () => {
  const dir = path.join(os.homedir(), '.openchrome');

  // Ensure the directory exists so df has a valid path
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Ignore if we can't create it
  }

  const targetDir = fs.existsSync(dir) ? dir : os.homedir();
  const freeMb = getFreeSpaceMb(targetDir);

  if (freeMb === null) {
    return {
      id: 'disk-space',
      title: 'Disk space',
      status: 'skip',
      detail: 'Could not determine free disk space on this platform',
    };
  }

  if (freeMb <= FAIL_THRESHOLD_MB) {
    return {
      id: 'disk-space',
      title: 'Disk space',
      status: 'fail',
      detail: `${freeMb} MB free on ${targetDir} filesystem (minimum: ${FAIL_THRESHOLD_MB} MB)`,
      remediation: `Free up disk space — openchrome needs at least ${WARN_THRESHOLD_MB} MB`,
    };
  }

  if (freeMb < WARN_THRESHOLD_MB) {
    return {
      id: 'disk-space',
      title: 'Disk space',
      status: 'warn',
      detail: `${freeMb} MB free on ${targetDir} filesystem (recommended: ≥${WARN_THRESHOLD_MB} MB)`,
      remediation: `Consider freeing up disk space — openchrome recommends at least ${WARN_THRESHOLD_MB} MB`,
    };
  }

  return {
    id: 'disk-space',
    title: 'Disk space',
    status: 'ok',
    detail: `${freeMb} MB free on ${targetDir} filesystem`,
  };
};
