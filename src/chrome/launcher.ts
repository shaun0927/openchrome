/**
 * Chrome Launcher - Manages Chrome process with remote debugging
 */

import { spawn, ChildProcess, execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { getGlobalConfig } from '../config/global';
import { DEFAULT_VIEWPORT } from '../config/defaults';
import { ProfileManager } from './profile-manager';
import type { ProfileType } from './profile-manager';
export type { ProfileType } from './profile-manager';

export interface ChromeInstance {
  wsEndpoint: string;
  httpEndpoint: string;
  process?: ChildProcess;
  userDataDir?: string;
  profileType?: ProfileType;
}

export interface LaunchOptions {
  port?: number;
  userDataDir?: string;
  headless?: boolean;
  /** If false, don't auto-launch Chrome when not running (default: false) */
  autoLaunch?: boolean;
  /** If true, force using a temp directory instead of real Chrome profile */
  useTempProfile?: boolean;
  /** If true, quit running Chrome to reuse the real profile (default: false — uses temp profile instead) */
  restartChrome?: boolean;
}

const DEFAULT_PORT = 9222;

/**
 * Find Chrome executable path based on platform
 */
function findChromePath(): string | null {
  // Check environment variable first
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
    // Linux - check explicit paths first (Snap, etc.)
    const linuxPaths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
      '/snap/bin/google-chrome',
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
    // Fallback to which
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

/**
 * Find chrome-headless-shell binary
 */
function findChromeHeadlessShell(): string | null {
  // Check environment variable first
  const envPath = process.env['CHROME_HEADLESS_SHELL'];
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // Check PATH using which (Linux/Mac) or where (Windows)
  const platform = os.platform();
  try {
    const cmd = platform === 'win32'
      ? 'where chrome-headless-shell'
      : 'which chrome-headless-shell';
    const result = execSync(cmd, { encoding: 'utf8' }).trim();
    if (result && fs.existsSync(result)) {
      return result;
    }
  } catch {
    // Not found in PATH
  }

  return null;
}

/**
 * Check if Chrome debug port is already available
 */
async function checkDebugPort(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/version',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.webSocketDebuggerUrl || null);
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

    req.end();
  });
}

/**
 * Wait for debug port to become available.
 * Optionally accepts a chromeProcess to fast-fail if Chrome exits before the port opens.
 */
async function waitForDebugPort(
  port: number,
  timeout = 30000,
  chromeProcess?: ChildProcess
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Fast-fail if the spawned Chrome process has already exited
    if (chromeProcess && chromeProcess.exitCode !== null) {
      throw new Error(
        `Chrome exited with code ${chromeProcess.exitCode} before debug port ${port} became available. ` +
        `Likely cause: --user-data-dir is locked by another Chrome instance.`
      );
    }

    const wsEndpoint = await checkDebugPort(port);
    if (wsEndpoint) {
      return wsEndpoint;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Chrome debug port ${port} not available after ${timeout}ms`);
}

export interface ProfileState {
  type: ProfileType;             // from profile-manager: 'real' | 'persistent' | 'temp' | 'explicit'
  cookieCopiedAt?: number;       // timestamp when cookies were copied (undefined for real profile)
  extensionsAvailable: boolean;
  sourceProfile?: string;        // path to the real profile (if synced from)
  userDataDir?: string;          // actual userDataDir being used
}

export class ChromeLauncher {
  private instance: ChromeInstance | null = null;
  private port: number;
  private profileManager = new ProfileManager();
  private currentProfileType: ProfileType | undefined;
  private profileState: ProfileState = {
    type: 'real',
    extensionsAvailable: true,
  };

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
  }

  /**
   * Ensure Chrome with remote debugging is available
   */
  async ensureChrome(options: LaunchOptions = {}): Promise<ChromeInstance> {
    const port = options.port || this.port;

    // Check if already connected and instance is still valid
    if (this.instance) {
      // Verify the cached instance is still valid by checking the debug port
      const currentWs = await checkDebugPort(port);
      if (currentWs && currentWs === this.instance.wsEndpoint) {
        return this.instance;
      }
      // Instance is stale, clear it
      console.error('[ChromeLauncher] Cached instance is stale, refreshing...');
      this.instance = null;
    }

    // Check if Chrome is already running with debug port.
    // Use a brief retry window (5s) instead of a single-shot check, because Chrome
    // may still be binding the debug port during startup (1-5s window).
    const existingWs = await waitForDebugPort(port, 5000).catch(() => null);
    if (existingWs) {
      console.error(`[ChromeLauncher] Found existing Chrome on port ${port}`);
      this.instance = {
        wsEndpoint: existingWs,
        httpEndpoint: `http://127.0.0.1:${port}`,
      };
      // Attached to user-started Chrome — assume real profile
      this.profileState = { type: 'real', extensionsAvailable: true };
      return this.instance;
    }

    // If autoLaunch is false (default), don't start Chrome automatically
    if (!options.autoLaunch) {
      throw new Error(
        `Chrome is not running with remote debugging on port ${port}.\n\n` +
        `Please start Chrome manually with:\n` +
        `  chrome --remote-debugging-port=${port}\n\n` +
        `Or use --auto-launch flag to start Chrome automatically.`
      );
    }

    // Graceful restart: only when explicitly opted in via --restart-chrome flag.
    // Default behavior: skip restart, fall through to temp profile + cookie copy.
    const restartChrome = options.restartChrome ?? getGlobalConfig().restartChrome ?? false;
    if (!options.useTempProfile && restartChrome) {
      const realProfileDir = this.getRealChromeProfileDir();
      if (realProfileDir && this.isProfileLocked(realProfileDir) && this.isChromeRunning()) {
        console.error('[ChromeLauncher] --restart-chrome: attempting graceful restart...');
        const unlocked = await this.quitAndUnlockProfile(realProfileDir);
        if (unlocked) {
          console.error('[ChromeLauncher] Chrome quit successfully, profile unlocked. Relaunching with debug port...');
        } else {
          console.error('[ChromeLauncher] Graceful restart failed, falling back to temp profile...');
        }
      }
    }

    // Launch new Chrome instance
    console.error(`[ChromeLauncher] Launching Chrome with debug port ${port}...`);

    const globalConfig = getGlobalConfig();

    // Resolve Chrome binary: explicit override > headless-shell > standard Chrome
    let chromePath: string | null = null;
    let usingHeadlessShell = false;

    if (globalConfig.chromeBinary) {
      chromePath = globalConfig.chromeBinary;
      console.error(`[ChromeLauncher] Using custom Chrome binary: ${chromePath}`);
    } else if (globalConfig.useHeadlessShell) {
      chromePath = findChromeHeadlessShell();
      if (chromePath) {
        usingHeadlessShell = true;
        console.error(`[ChromeLauncher] Using chrome-headless-shell: ${chromePath}`);
      } else {
        console.error('[ChromeLauncher] chrome-headless-shell not found, falling back to standard Chrome');
        chromePath = findChromePath();
      }
    } else {
      chromePath = findChromePath();
    }

    if (!chromePath) {
      throw new Error(
        'Chrome not found. Please install Google Chrome or set CHROME_PATH environment variable.'
      );
    }

    // Resolve which profile directory to use via ProfileManager.
    // Priority: explicit > temp/headless > real unlocked > persistent (with sync) > persistent (no sync)
    const realProfileDir = this.getRealChromeProfileDir();
    const explicitUserDataDir = options.userDataDir || globalConfig.userDataDir;
    // Skip expensive isProfileLocked check when result won't be used
    const isLocked = (!explicitUserDataDir && !options.useTempProfile && !usingHeadlessShell && realProfileDir)
      ? this.isProfileLocked(realProfileDir)
      : false;

    const resolution = this.profileManager.resolveProfile({
      realProfileDir,
      isProfileLocked: isLocked,
      explicitUserDataDir,
      useTempProfile: options.useTempProfile,
      usingHeadlessShell,
    });

    const userDataDir = resolution.userDataDir;
    const profileType = resolution.profileType;
    this.currentProfileType = profileType;

    // Track profile state for MCP consumers
    this.profileState = {
      type: profileType,
      extensionsAvailable: profileType === 'real' || profileType === 'explicit',
      ...(resolution.syncPerformed && { cookieCopiedAt: Date.now() }),
      ...(realProfileDir && profileType === 'persistent' && { sourceProfile: realProfileDir }),
      userDataDir,
    };

    if (resolution.syncPerformed) {
      console.error(`[ChromeLauncher] Using persistent profile with fresh cookie sync: ${userDataDir}`);
    } else if (profileType === 'persistent') {
      console.error(`[ChromeLauncher] Using persistent profile (cookies fresh): ${userDataDir}`);
    } else if (profileType === 'real') {
      console.error(`[ChromeLauncher] Using real Chrome profile: ${userDataDir}`);
    } else if (profileType === 'temp') {
      console.error(`[ChromeLauncher] Using temp profile: ${userDataDir}`);
    } else {
      console.error(`[ChromeLauncher] Using explicit profile: ${userDataDir}`);
    }

    fs.mkdirSync(userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-restore-last-session',
      // IMPORTANT: Start maximized for proper debugging experience
      '--start-maximized',
      // Fallback window size if maximize doesn't work
      `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
      // Memory-saving flags (applies to all profile types)
      '--renderer-process-limit=16',
      '--js-flags=--max-old-space-size=1024',
      '--disable-backgrounding-occluded-windows',
      '--disable-ipc-flooding-protection',
    ];

    // Only disable background features for non-real profiles
    if (profileType !== 'real') {
      args.push(
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
      );
    }

    // Headless mode: explicit option > global config (default when auto-launch)
    const headless = options.headless ?? globalConfig.headless ?? false;
    if (headless) {
      args.push('--headless=new', '--disable-gpu', '--disable-dev-shm-usage');
      console.error('[ChromeLauncher] Running in headless mode (no visible window)');
    }

    // CI/Docker environments require --no-sandbox (Chrome won't start otherwise)
    if (process.env.CI || process.env.DOCKER) {
      args.push('--no-sandbox', '--disable-setuid-sandbox');
      console.error('[ChromeLauncher] CI/Docker detected: sandbox disabled');
    }

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      // shell: false is safe on all platforms; avoids cmd.exe injection risks on Windows
    });

    chromeProcess.unref();
    // Note: On Windows, detached processes create a new process group.
    // Killing the root process may not clean up child processes (renderers, GPU).
    // The oc_stop tool handles this via session/pool cleanup before process kill.

    // Log Chrome process exit for immediate diagnostics
    chromeProcess.once('exit', (code, signal) => {
      console.error(`[ChromeLauncher] Chrome process exited (code: ${code}, signal: ${signal})`);
    });

    // Wait for debug port — pass chromeProcess for fast-fail on premature exit
    const wsEndpoint = await waitForDebugPort(port, 30000, chromeProcess);

    this.instance = {
      wsEndpoint,
      httpEndpoint: `http://127.0.0.1:${port}`,
      process: chromeProcess,
      userDataDir,
      profileType,
    };

    console.error(`[ChromeLauncher] Chrome ready at ${wsEndpoint}`);
    return this.instance;
  }

  /**
   * Invalidate cached instance so next ensureChrome() re-fetches from HTTP.
   * Called by CDPClient when puppeteer.connect() fails and a retry is needed.
   *
   * NOTE: Not concurrency-safe with ensureChrome(). Safe to call when
   * ensureChrome() is not in-flight (e.g., after puppeteer.connect() fails,
   * before the 1s retry sleep). At worst causes an extra HTTP probe (~2-5s).
   */
  invalidateInstance(): void {
    if (this.instance) {
      console.error('[ChromeLauncher] Cached instance invalidated (will re-fetch from HTTP)');
      this.instance = null;
    }
  }

  /**
   * Get debug endpoint URL
   */
  async getDebugEndpoint(): Promise<string> {
    if (!this.instance) {
      await this.ensureChrome();
    }
    return this.instance!.httpEndpoint;
  }

  /**
   * Get WebSocket endpoint
   */
  async getWsEndpoint(): Promise<string> {
    if (!this.instance) {
      await this.ensureChrome();
    }
    return this.instance!.wsEndpoint;
  }

  /**
   * Close Chrome instance (only if we launched it)
   */
  async close(): Promise<void> {
    if (this.instance?.process) {
      console.error('[ChromeLauncher] Closing Chrome...');
      if (process.platform === 'win32' && this.instance.process.pid) {
        try {
          // On Windows, kill the entire process tree to clean up renderer/GPU children
          execSync(`taskkill /T /F /PID ${this.instance.process.pid}`, { stdio: 'ignore' });
          console.error(`[ChromeLauncher] Windows: killed process tree for PID ${this.instance.process.pid}`);
        } catch {
          // Fallback to regular kill if taskkill fails
          this.instance.process.kill();
        }
      } else {
        this.instance.process.kill();
      }

      // Clean up user data dir — only delete temp profiles.
      // Persistent profiles survive across sessions; real/explicit profiles are never ours to delete.
      if (this.instance.userDataDir && this.currentProfileType === 'temp') {
        try {
          fs.rmSync(this.instance.userDataDir, { recursive: true, force: true });
          console.error(`[ChromeLauncher] Cleaned up temp profile: ${this.instance.userDataDir}`);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    this.instance = null;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.instance !== null;
  }

  /**
   * Get the port this launcher is configured for
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the current profile type. Useful for MCP consumers to understand
   * what capabilities are available (e.g., extensions only with 'real' profile).
   */
  getProfileType(): ProfileType | undefined {
    return this.currentProfileType;
  }

  /**
   * Get the current profile state.
   * Describes what type of Chrome profile is in use and its capabilities.
   */
  getProfileState(): ProfileState {
    return { ...this.profileState };
  }

  /**
   * Get the real Chrome profile directory for the current platform
   */
  private getRealChromeProfileDir(): string | null {
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'darwin') {
      const profileDir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
      if (fs.existsSync(profileDir)) return profileDir;
    } else if (platform === 'win32') {
      const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
      const profileDir = path.join(localAppData, 'Google', 'Chrome', 'User Data');
      if (fs.existsSync(profileDir)) return profileDir;
    } else {
      // Linux
      const candidates = [
        path.join(home, '.config', 'google-chrome'),
        path.join(home, '.config', 'chromium'),
        path.join(home, 'snap', 'chromium', 'current', '.config', 'chromium'),
      ];
      for (const profileDir of candidates) {
        if (fs.existsSync(profileDir)) return profileDir;
      }
    }

    return null;
  }

  /**
   * Check if a Chrome profile directory is locked by another Chrome instance.
   * On Unix, validates SingletonLock symlink targets by checking if the PID is alive,
   * so stale lock files from crashed Chrome instances are correctly ignored.
   */
  private isProfileLocked(profileDir: string): boolean {
    if (os.platform() === 'win32') {
      // Windows Chrome uses a 'lockfile' in the user data directory
      const lockFile = path.join(profileDir, 'lockfile');
      if (fs.existsSync(lockFile)) {
        console.error(`[ChromeLauncher] Profile locked: ${lockFile} exists`);
        return true;
      }
      return false;
    }

    // Unix: Chrome uses SingletonLock (symlink to "hostname-pid"), SingletonSocket, SingletonCookie
    const lockFiles = [
      path.join(profileDir, 'SingletonLock'),
      path.join(profileDir, 'SingletonSocket'),
      path.join(profileDir, 'SingletonCookie'),
    ];

    for (const lockFile of lockFiles) {
      // Use lstatSync instead of existsSync because SingletonLock is a dangling symlink
      // (target "hostname-pid" doesn't exist as a file), and existsSync follows symlinks.
      try {
        const stats = fs.lstatSync(lockFile);

        // For symlinks (SingletonLock), validate the PID is still alive
        if (stats.isSymbolicLink()) {
          try {
            const target = fs.readlinkSync(lockFile);
            const pid = parseInt(target.split('-').pop()!, 10);
            if (!isNaN(pid) && pid > 0) {
              try {
                process.kill(pid, 0); // Signal 0: check if process exists without killing
              } catch (err) {
                // EPERM means process exists but owned by another user — treat as alive
                if ((err as NodeJS.ErrnoException).code === 'EPERM') {
                  // Lock is held by an existing Chrome process — do not skip
                } else {
                  // PID not alive → stale lock file left by crashed Chrome, skip it
                  console.error(`[ChromeLauncher] Stale lock ignored: ${lockFile} (PID ${pid} not alive)`);
                  continue;
                }
              }
            }
          } catch {
            // readlinkSync failed — can't validate, assume locked for safety
          }
        }

        console.error(`[ChromeLauncher] Profile locked: ${lockFile} exists`);
        return true;
      } catch {
        // lstatSync throws if file doesn't exist → not locked by this file
        continue;
      }
    }

    return false;
  }

  /**
   * Check if Chrome is currently running (regardless of debug port)
   */
  private isChromeRunning(): boolean {
    const platform = os.platform();
    try {
      if (platform === 'darwin') {
        execFileSync('pgrep', ['-x', 'Google Chrome'], { stdio: 'ignore' });
        return true;
      } else if (platform === 'win32') {
        const output = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return output.toLowerCase().includes('chrome.exe');
      } else {
        const linuxNames = ['chrome', 'google-chrome', 'chromium', 'chromium-browser'];
        for (const name of linuxNames) {
          try {
            execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
            return true;
          } catch {
            // try next
          }
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Gracefully quit running Chrome using platform-specific commands.
   * Returns true if Chrome exited within the timeout.
   */
  private async quitRunningChrome(timeout = 10000): Promise<boolean> {
    const platform = os.platform();
    try {
      if (platform === 'darwin') {
        execSync('osascript -e \'tell application "Google Chrome" to quit\'', { stdio: 'ignore' });
      } else if (platform === 'win32') {
        // taskkill without /F sends WM_CLOSE for graceful shutdown
        execSync('taskkill /IM chrome.exe', { stdio: 'ignore' });
      } else {
        for (const name of ['chrome', 'google-chrome', 'chromium', 'chromium-browser']) {
          try { execFileSync('pkill', ['-TERM', name], { stdio: 'ignore' }); } catch { /* not running under this name */ }
        }
      }
    } catch {
      // Quit command failed — Chrome may have already exited or command not available
      console.error('[ChromeLauncher] Quit command failed, checking if Chrome exited...');
    }

    // Poll until Chrome exits
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!this.isChromeRunning()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    console.error(`[ChromeLauncher] Chrome did not exit within ${timeout}ms`);
    return false;
  }

  /**
   * Quit Chrome and wait for the profile lock to be released.
   * Returns true if the profile was successfully unlocked.
   */
  private async quitAndUnlockProfile(profileDir: string, quitTimeout = 10000, unlockTimeout = 5000): Promise<boolean> {
    const chromeExited = await this.quitRunningChrome(quitTimeout);
    if (!chromeExited) {
      return false;
    }

    // Poll until profile lock is released
    const startTime = Date.now();
    while (Date.now() - startTime < unlockTimeout) {
      if (!this.isProfileLocked(profileDir)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    console.error(`[ChromeLauncher] Profile lock not released within ${unlockTimeout}ms`);
    return false;
  }
}

// Singleton instance
let launcherInstance: ChromeLauncher | null = null;

export function getChromeLauncher(port?: number): ChromeLauncher {
  const resolvedPort = port || DEFAULT_PORT;
  if (!launcherInstance || launcherInstance.getPort() !== resolvedPort) {
    if (launcherInstance) {
      console.error(`[ChromeLauncher] Replacing singleton (port ${launcherInstance.getPort()} → ${resolvedPort})`);
    }
    launcherInstance = new ChromeLauncher(resolvedPort);
  }
  return launcherInstance;
}
