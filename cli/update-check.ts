/**
 * Update checker - warns users when a newer version is available.
 * Non-blocking, cached (24h), and silent on failure.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PACKAGE_NAME = 'claude-chrome-parallel';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

function getCachePath(): string {
  const cacheDir = path.join(os.homedir(), '.claude-chrome-parallel');
  return path.join(cacheDir, 'update-check.json');
}

function readCache(): UpdateCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - data.lastCheck < CACHE_TTL_MS) {
      return data;
    }
    return null; // Expired
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    const cachePath = getCachePath();
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify({
      lastCheck: Date.now(),
      latestVersion,
    }));
  } catch {
    // Silent failure - cache is optional
  }
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function compareVersions(current: string, latest: string): number {
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return -1;
    if ((a[i] || 0) > (b[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Check for updates and print a warning if outdated.
 * Non-blocking — fires and forgets. Never throws.
 */
export async function checkForUpdates(currentVersion: string): Promise<void> {
  try {
    // Check cache first
    const cached = readCache();
    let latestVersion: string | null = cached?.latestVersion || null;

    if (!cached) {
      latestVersion = await fetchLatestVersion();
      if (latestVersion) {
        writeCache(latestVersion);
      }
    }

    if (latestVersion && compareVersions(currentVersion, latestVersion) < 0) {
      console.error('');
      console.error(`  Update available: ${currentVersion} → ${latestVersion}`);
      console.error(`  Run: npm update -g ${PACKAGE_NAME}`);
      console.error('');
    }
  } catch {
    // Silent failure — update check should never break the server
  }
}
