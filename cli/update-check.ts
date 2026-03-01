/**
 * Update checker - warns users when a newer version is available.
 * Non-blocking, cached (24h), and silent on failure.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PACKAGE_NAME = 'openchrome-mcp';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

function getCachePath(): string {
  const cacheDir = path.join(os.homedir(), '.openchrome');
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
 * Clear stale npx cache entries for openchrome-mcp.
 * This ensures the next npx invocation fetches the latest version
 * from the registry instead of serving a stale cached copy.
 */
function clearNpxCache(): boolean {
  try {
    const npxCacheDir = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(npxCacheDir)) return false;

    let cleared = false;
    const entries = fs.readdirSync(npxCacheDir);
    for (const entry of entries) {
      const pkgDir = path.join(npxCacheDir, entry, 'node_modules', PACKAGE_NAME);
      if (fs.existsSync(pkgDir)) {
        // Remove the entire npx cache entry (includes package-lock.json)
        fs.rmSync(path.join(npxCacheDir, entry), { recursive: true, force: true });
        cleared = true;
      }
    }
    return cleared;
  } catch {
    return false;
  }
}

/**
 * Check for updates. If outdated, auto-clear the npx cache so the
 * next server restart fetches the latest version automatically.
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
      // Auto-clear npx cache so next restart gets the new version
      const cleared = clearNpxCache();

      console.error('');
      console.error(`  ⬆ Update available: ${currentVersion} → ${latestVersion}`);
      if (cleared) {
        console.error(`  Cache cleared — restart Claude Code to use the new version.`);
      } else {
        console.error(`  Run: npx openchrome-mcp@latest setup`);
      }
      console.error('');
    }
  } catch {
    // Silent failure — update check should never break the server
  }
}
