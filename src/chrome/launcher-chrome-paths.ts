import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function findChromePath(): string | null {
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
    for (const p of paths) if (fs.existsSync(p)) return p;
  } else if (platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    for (const p of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/snap/bin/chromium', '/snap/bin/google-chrome']) {
      if (fs.existsSync(p)) return p;
    }
    try {
      return execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

export function findChromeHeadlessShell(): string | null {
  const envPath = process.env['CHROME_HEADLESS_SHELL'];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const platform = os.platform();
  try {
    const cmd = platform === 'win32' ? 'where chrome-headless-shell' : 'which chrome-headless-shell';
    const result = execSync(cmd, { encoding: 'utf8' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {
    // Not found in PATH.
  }
  return null;
}
