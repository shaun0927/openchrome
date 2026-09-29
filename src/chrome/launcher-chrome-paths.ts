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

export const MAC_STABLE_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CFT_EXECUTABLE = path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');

/** Reads CFBundleShortVersionString from the .app that contains `executablePath`. */
export function readMacAppVersion(executablePath: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(executablePath, '..', '..', 'Info.plist'), 'utf8');
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([\d.]+)<\/string>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Chrome for Testing installs from /Applications, Playwright's cache and Puppeteer's cache. */
export function macChromeForTestingCandidates(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const candidates = [path.join('/Applications', CFT_EXECUTABLE)];
  const cacheRoots = [
    env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, 'Library', 'Caches', 'ms-playwright'),
    path.join(env.PUPPETEER_CACHE_DIR || path.join(home, '.cache', 'puppeteer'), 'chrome'),
  ];
  // Both caches use <root>/<version dir>/<platform dir>/Google Chrome for Testing.app
  for (const root of cacheRoots) {
    let versionDirs: string[];
    try {
      versionDirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const versionDir of versionDirs) {
      let platformDirs: string[];
      try {
        platformDirs = fs.readdirSync(path.join(root, versionDir));
      } catch {
        continue;
      }
      for (const platformDir of platformDirs) {
        candidates.push(path.join(root, versionDir, platformDir, CFT_EXECUTABLE));
      }
    }
  }
  return candidates;
}

/**
 * On macOS, a headless Chrome spawned from /Applications/Google Chrome.app shares
 * the user's Chrome bundle ID, so LaunchServices treats it as "Chrome is running":
 * clicking the Dock icon or opening a link is routed to the windowless instance
 * and the user's browser appears locked. Chrome for Testing has its own bundle ID
 * (com.google.chrome.for.testing) and does not collide.
 *
 * Returns the newest Chrome for Testing whose major version is >= the installed
 * Google Chrome's, so a persistent profile last written by stable Chrome is never
 * opened by an older milestone. Returns null (keep stable Chrome) when no safe
 * candidate exists or either version cannot be read.
 */
export function findIsolatedMacHeadlessChrome(
  stableChromePath: string = MAC_STABLE_CHROME_PATH,
  candidates: string[] = macChromeForTestingCandidates(),
): string | null {
  const stableVersion = readMacAppVersion(stableChromePath);
  if (!stableVersion) return null;
  const minMajor = Number(stableVersion.split('.')[0]);

  let best: { path: string; version: string } | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const version = readMacAppVersion(candidate);
    if (!version || Number(version.split('.')[0]) < minMajor) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { path: candidate, version };
  }
  return best?.path ?? null;
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
