/**
 * Chrome Launcher - Manages Chrome process with remote debugging
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';

export interface ChromeInstance {
  wsEndpoint: string;
  httpEndpoint: string;
  process?: ChildProcess;
  userDataDir?: string;
}

export interface LaunchOptions {
  port?: number;
  userDataDir?: string;
  headless?: boolean;
  /** If false, don't auto-launch Chrome when not running (default: false) */
  autoLaunch?: boolean;
}

const DEFAULT_PORT = 9222;

/**
 * Find Chrome executable path based on platform
 */
function findChromePath(): string | null {
  const platform = os.platform();

  if (platform === 'win32') {
    const paths = [
      process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
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
    // Linux
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
 * Wait for debug port to become available
 */
async function waitForDebugPort(port: number, timeout = 30000): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const wsEndpoint = await checkDebugPort(port);
    if (wsEndpoint) {
      return wsEndpoint;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Chrome debug port ${port} not available after ${timeout}ms`);
}

export class ChromeLauncher {
  private instance: ChromeInstance | null = null;
  private port: number;

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

    // Check if Chrome is already running with debug port
    const existingWs = await checkDebugPort(port);
    if (existingWs) {
      console.error(`[ChromeLauncher] Found existing Chrome on port ${port}`);
      this.instance = {
        wsEndpoint: existingWs,
        httpEndpoint: `http://127.0.0.1:${port}`,
      };
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

    // Launch new Chrome instance
    console.error(`[ChromeLauncher] Launching Chrome with debug port ${port}...`);

    const chromePath = findChromePath();
    if (!chromePath) {
      throw new Error(
        'Chrome not found. Please install Google Chrome or set CHROME_PATH environment variable.'
      );
    }

    // Create unique user data directory (Chrome 136+ requirement)
    const userDataDir =
      options.userDataDir ||
      path.join(os.tmpdir(), `claude-chrome-parallel-${Date.now()}`);

    fs.mkdirSync(userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
    ];

    if (options.headless) {
      args.push('--headless=new');
    }

    const chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    chromeProcess.unref();

    // Wait for debug port
    const wsEndpoint = await waitForDebugPort(port);

    this.instance = {
      wsEndpoint,
      httpEndpoint: `http://127.0.0.1:${port}`,
      process: chromeProcess,
      userDataDir,
    };

    console.error(`[ChromeLauncher] Chrome ready at ${wsEndpoint}`);
    return this.instance;
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
      this.instance.process.kill();

      // Clean up user data dir
      if (this.instance.userDataDir) {
        try {
          fs.rmSync(this.instance.userDataDir, { recursive: true, force: true });
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
}

// Singleton instance
let launcherInstance: ChromeLauncher | null = null;

export function getChromeLauncher(port?: number): ChromeLauncher {
  if (!launcherInstance) {
    launcherInstance = new ChromeLauncher(port);
  }
  return launcherInstance;
}
