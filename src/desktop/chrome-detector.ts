/**
 * Chrome Detector — detects Chrome installation for the desktop app UI.
 * Emits events so the UI can prompt the user to install Chrome if missing.
 * Part of #524 Desktop App: Error handling + local fallback + CLI coexistence.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';

export interface ChromeDetectionResult {
  found: boolean;
  path: string | null;
  platform: NodeJS.Platform;
  /** User-friendly message with no technical jargon */
  message: string;
  /** URL to download Chrome */
  downloadUrl: string;
}

export interface ChromeDetectorOptions {
  /** Polling interval in milliseconds. Default: 5000 (5s) */
  intervalMs?: number;
}

/**
 * Find the Chrome executable path for the current platform.
 * Mirrors the detection logic from src/chrome/launcher.ts so both
 * the MCP server and the desktop app use the same set of paths.
 */
function findChromePath(): string | null {
  // Honour explicit override
  const envPath = process.env['CHROME_PATH'];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const platform = os.platform();

  if (platform === 'win32') {
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const pf = process.env['PROGRAMFILES'];
    const local = process.env['LOCALAPPDATA'];
    const candidates: string[] = [];
    if (pf86) candidates.push(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (pf) candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (local) candidates.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    // Linux — check explicit paths first (Snap, apt, etc.)
    const linuxPaths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
      '/snap/bin/google-chrome',
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
    // Fall back to PATH search (same order as launcher.ts)
    const whichCandidates = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    for (const bin of whichCandidates) {
      try {
        const result = execFileSync('which', [bin], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        if (result) return result;
      } catch {
        // not found, try next
      }
    }
  }

  return null;
}

function buildResult(chromePath: string | null): ChromeDetectionResult {
  const platform = os.platform();
  if (chromePath) {
    return {
      found: true,
      path: chromePath,
      platform,
      message: 'Chrome is installed and ready to use.',
      downloadUrl: CHROME_DOWNLOAD_URL,
    };
  }
  return {
    found: false,
    path: null,
    platform,
    message:
      'Chrome was not found on this computer. Please install Chrome to use this app, then click Retry.',
    downloadUrl: CHROME_DOWNLOAD_URL,
  };
}

/**
 * ChromeDetector — event-driven Chrome installation detector.
 *
 * Events:
 *   'detected'  — Chrome was found: (result: ChromeDetectionResult)
 *   'not-found' — Chrome is missing: (result: ChromeDetectionResult)
 *   'error'     — Unexpected error during detection: (err: Error)
 */
export class ChromeDetector extends EventEmitter {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts?: ChromeDetectorOptions) {
    super();
    this.intervalMs = opts?.intervalMs ?? 5000;
  }

  /**
   * Run a one-shot detection and emit the appropriate event.
   */
  async detect(): Promise<ChromeDetectionResult> {
    try {
      const chromePath = findChromePath();
      const result = buildResult(chromePath);
      if (result.found) {
        this.emit('detected', result);
      } else {
        this.emit('not-found', result);
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[ChromeDetector] Unexpected error during detection:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Re-run detection — identical to detect() but semantically signals a
   * user-initiated retry after they have (hopefully) installed Chrome.
   */
  async retry(): Promise<ChromeDetectionResult> {
    return this.detect();
  }

  /**
   * Start periodic polling for Chrome.
   * Useful for "install Chrome then click Retry" UX: the app polls in the
   * background and automatically enables the Start button once Chrome appears.
   * The timer is .unref()'d so it does not prevent process exit.
   */
  startPolling(intervalMs?: number): void {
    this.stopPolling(); // clear any existing timer

    const ms = intervalMs ?? this.intervalMs;
    this.timer = setInterval(() => {
      this.detect().catch((err) => {
        console.error('[ChromeDetector] Error during polling:', err);
      });
    }, ms);
    this.timer.unref();
  }

  /**
   * Stop periodic polling.
   */
  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Whether periodic polling is currently active.
   */
  isPolling(): boolean {
    return this.timer !== null;
  }
}
