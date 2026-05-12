/**
 * Check: chrome-binary
 * Locates Chrome and verifies it reports a supported major version.
 * Uses findChromePath() and findChromeHeadlessShell() from the launcher module.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { execSync } from 'child_process';
import type { CheckFn } from '../../doctor';

// Minimum supported Chrome major version
const MIN_CHROME_MAJOR = 88;

function findChromePath(): string | null {
  const envChromePath = process.env.CHROME_PATH;
  if (envChromePath && fs.existsSync(envChromePath)) return envChromePath;

  const platform = os.platform();

  if (platform === 'win32') {
    const envProgramFilesX86 = process.env['PROGRAMFILES(X86)'];
    const envProgramFiles = process.env['PROGRAMFILES'];
    const envLocalAppData = process.env['LOCALAPPDATA'];
    const paths: string[] = [];
    if (envProgramFilesX86) paths.push(path.join(envProgramFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (envProgramFiles) paths.push(path.join(envProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (envLocalAppData) paths.push(path.join(envLocalAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    const linuxPaths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
      '/snap/bin/google-chrome',
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
    try {
      return execSync('which google-chrome || which chromium-browser || which chromium', {
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  }

  return null;
}

function findChromeHeadlessShell(): string | null {
  const envPath = process.env['CHROME_HEADLESS_SHELL'];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const platform = os.platform();
  try {
    const cmd = platform === 'win32' ? 'where chrome-headless-shell' : 'which chrome-headless-shell';
    const result = execSync(cmd, { encoding: 'utf8' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // Not found in PATH
  }

  return null;
}

function probeChromeVersion(chromePath: string): { major: number; raw: string } | null {
  try {
    const output = execFileSync(chromePath, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
    }).trim();
    const match = output.match(/\d+/);
    if (!match) return null;
    return { major: parseInt(match[0], 10), raw: output };
  } catch {
    return null;
  }
}

export const checkChromeBinary: CheckFn = async () => {
  const candidatePath = findChromePath() ?? findChromeHeadlessShell();

  if (!candidatePath) {
    return {
      id: 'chrome-binary',
      title: 'Chrome binary',
      status: 'fail',
      detail: 'Chrome executable not found on this system',
      remediation: 'Install Google Chrome, or set CHROME_PATH env var to the binary path',
    };
  }

  const version = probeChromeVersion(candidatePath);
  if (!version) {
    return {
      id: 'chrome-binary',
      title: 'Chrome binary',
      status: 'fail',
      detail: `Found at ${candidatePath} but could not determine version`,
      remediation: `Ensure Chrome is executable: chmod +x "${candidatePath}"`,
    };
  }

  if (version.major < MIN_CHROME_MAJOR) {
    return {
      id: 'chrome-binary',
      title: 'Chrome binary',
      status: 'fail',
      detail: `${version.raw} at ${candidatePath} (minimum major: ${MIN_CHROME_MAJOR})`,
      remediation: 'Upgrade Chrome to a recent stable release — https://www.google.com/chrome',
    };
  }

  return {
    id: 'chrome-binary',
    title: 'Chrome binary',
    status: 'ok',
    detail: `${version.raw} at ${candidatePath}`,
  };
};
