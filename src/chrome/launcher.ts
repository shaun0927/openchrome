/**
 * Chrome Launcher - Manages Chrome process with remote debugging
 */

import { spawn, ChildProcess, execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { getGlobalConfig } from '../config/global';
import { writeChromePid, removeChromePid, getChromePidFilePath, killProcessTree } from '../utils/pid-manager';
import { spawnProcessGuardian } from '../utils/process-guardian';
import { DEFAULT_VIEWPORT, DEFAULT_CHROME_LAUNCH_TIMEOUT_MS, DEFAULT_RESTORE_LAST_SESSION } from '../config/defaults';
import type { WindowBoundsConfig } from '../config/window-bounds';
import { ProfileManager } from './profile-manager';
import type { ProfileType } from './profile-manager';
import { writeMarker, removeMarker } from './ownership-marker';
import { registerManagedChrome, unregisterManagedChrome } from '../utils/sync-shutdown';
import { classifyExit, ExitClassification, quiesceMs } from './exit-classifier';
import {
  resolveLaunchMode,
  AttachConsentRequiredError,
  LaunchMode as ResolvedLaunchMode,
} from './launch-mode-resolver';
import { detectRunningChromes, filterByProfile, pickPreferredChrome } from './process-detector';
export type { ProfileType } from './profile-manager';

/**
 * Lifecycle ownership of a Chrome process (#661).
 * - 'isolated': openchrome spawned this Chrome and owns its lifecycle. Eligible for sync-kill on exit.
 * - 'attach': we connected to a Chrome the user was already running. NEVER killed by openchrome.
 *
 * Distinct from `LaunchMode` (#659 — auto/attach/isolated launch *strategy*),
 * exported below from launch-mode-resolver. To avoid the name shadow noted in
 * gemini's review of #670, the runtime ownership tag is named `LifecycleMode`.
 *
 * Note: the field on `ChromeInstance` is still called `launchMode` for source
 * compatibility with consumers like the watchdog and sync-shutdown that
 * already reference it.
 */
export type LifecycleMode = 'isolated' | 'attach';
/** @deprecated Use `LifecycleMode`. Retained for source compatibility. */
export type LaunchMode = LifecycleMode;

export interface ChromeInstance {
  wsEndpoint: string;
  httpEndpoint: string;
  process?: ChildProcess;
  userDataDir?: string;
  profileType?: ProfileType;
  /** Lifecycle ownership (#661). Defaults to 'isolated' for our spawn-based path. */
  launchMode?: LifecycleMode;
  /** Random per-launch UUID written into the ownership marker file. */
  ownershipMarker?: string;
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
  /** Chrome profile directory name (e.g., "Profile 1"). Passed as --profile-directory flag */
  profileDirectory?: string;
  /** If true, restore Chrome's previous session tabs after crash (default: false).
   *  Enable for long-running sessions where tab preservation matters. */
  restoreLastSession?: boolean;
  /** #659 launch-mode override (per-call). One of: 'auto' | 'attach' | 'isolated'.
   *  Highest precedence; falls back to OPENCHROME_LAUNCH_MODE then config then 'auto'. */
  launchMode?: 'auto' | 'attach' | 'isolated';
  /** Headed Chrome window size. Ignored when windowBounds is set. */
  windowSize?: WindowBoundsConfig['windowSize'];
  /** Headed Chrome window position. Ignored when windowBounds is set. */
  windowPosition?: WindowBoundsConfig['windowPosition'];
  /** Headed Chrome window bounds. Overrides size and position. */
  windowBounds?: WindowBoundsConfig['windowBounds'];
  /** Maximize headed Chrome only when no explicit geometry is set. */
  startMaximized?: boolean;
}

const DEFAULT_PORT = 9222;
const DEFAULT_HEADED_WINDOW_POSITION = { x: 0, y: 0 } as const;
const DEFAULT_HEADED_WINDOW_SIZE = { width: 1280, height: 900 } as const;

export function getHeadedWindowArgs(config: WindowBoundsConfig): string[] {
  const hasExplicitGeometry = Boolean(config.windowBounds || config.windowSize || config.windowPosition);

  if (config.startMaximized === true && !hasExplicitGeometry) {
    return ['--start-maximized'];
  }

  if (config.windowBounds) {
    return [
      `--window-position=${config.windowBounds.x},${config.windowBounds.y}`,
      `--window-size=${config.windowBounds.width},${config.windowBounds.height}`,
    ];
  }

  const position = config.windowPosition ?? DEFAULT_HEADED_WINDOW_POSITION;
  const size = config.windowSize ?? DEFAULT_HEADED_WINDOW_SIZE;
  return [
    `--window-position=${position.x},${position.y}`,
    `--window-size=${size.width},${size.height}`,
  ];
}

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
 * Error thrown when the Chrome debug port fails to become available
 * within the requested monotonic deadline. Distinct from the generic
 * "Chrome exited" error so callers can distinguish startup slowness
 * from early process termination.
 */
export class DebugPortTimeoutError extends Error {
  readonly port: number;
  readonly timeoutMs: number;
  readonly attempts: number;

  constructor(port: number, timeoutMs: number, attempts: number) {
    super(
      `Chrome debug port ${port} not available after ${timeoutMs}ms ` +
      `(${attempts} probe attempts). Chrome may still be starting, ` +
      `or the port may be blocked by a firewall or in use by another process.`
    );
    this.name = 'DebugPortTimeoutError';
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;
  }
}

const DEBUG_PORT_MAX_HTTP_TIMEOUT_MS = 2000;
const DEBUG_PORT_INITIAL_BACKOFF_MS = 200;
const DEBUG_PORT_MAX_BACKOFF_MS = 2000;
const DEBUG_PORT_BACKOFF_FACTOR = 1.5;
const DEBUG_PORT_PROGRESS_LOG_INTERVAL = 10;

/**
 * Check if Chrome debug port is already available.
 *
 * @param port TCP port where Chrome's `/json/version` endpoint is expected.
 * @param timeoutMs Per-request HTTP timeout. Defaults to
 *   {@link DEBUG_PORT_MAX_HTTP_TIMEOUT_MS}. Callers should cap this at the
 *   remaining budget when polling so a single slow probe cannot exceed the
 *   outer deadline.
 */
async function checkDebugPort(
  port: number,
  timeoutMs: number = DEBUG_PORT_MAX_HTTP_TIMEOUT_MS,
): Promise<string | null> {
  // Clamp to [1, MAX]. A lower bound of 1ms (not the old 100ms floor) lets
  // waitForDebugPort use the last sliver of its remaining budget — localhost
  // probes often complete in well under 10ms, so short windows can still
  // succeed instead of being thrown away.
  const clampedTimeout = Math.min(
    Math.max(1, timeoutMs),
    DEBUG_PORT_MAX_HTTP_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/version',
        method: 'GET',
        timeout: clampedTimeout,
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
 * Wait for Chrome's debug port to become available.
 *
 * Uses a monotonic deadline (`Date.now() + timeout`) rather than a
 * running elapsed counter so the total wall time is strictly bounded.
 * On every iteration the remaining budget caps both the HTTP probe
 * timeout and the post-failure backoff, guaranteeing that a single
 * slow iteration cannot push the total past `timeout` by more than
 * one clamped HTTP attempt.
 *
 * Backoff grows exponentially from {@link DEBUG_PORT_INITIAL_BACKOFF_MS}
 * so early probes are tight (catches fast startups) while later probes
 * avoid busy-looping against a port that is genuinely unreachable.
 *
 * @throws {DebugPortTimeoutError} when `timeout` elapses without a
 *   successful probe. The chromeProcess fast-fail path continues to
 *   throw a generic `Error` with the exit code.
 */
export async function waitForDebugPort(
  port: number,
  timeout = 30000,
  chromeProcess?: ChildProcess
): Promise<string> {
  // Normalize non-finite / negative inputs. A caller could reach this via a
  // malformed env var that was run through parseInt and silently became NaN;
  // letting that propagate into `Date.now() + timeout` poisons every downstream
  // comparison (NaN <= 0 is false) and turns waitForDebugPort into an
  // indefinite loop that eventually tries to pass NaN to http.request.
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new DebugPortTimeoutError(port, 0, 0);
  }
  const deadline = Date.now() + timeout;
  let attempts = 0;
  let backoff = DEBUG_PORT_INITIAL_BACKOFF_MS;

  while (Date.now() <= deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DebugPortTimeoutError(port, timeout, attempts);
    }

    // Fast-fail if the spawned Chrome process has already exited
    if (chromeProcess && chromeProcess.exitCode !== null) {
      throw new Error(
        `Chrome exited with code ${chromeProcess.exitCode} before debug port ${port} became available. ` +
        `Likely cause: --user-data-dir is locked by another Chrome instance.`
      );
    }

    // Always probe with whatever budget remains. Dropping the old
    // `remaining < MIN_HTTP_TIMEOUT` short-circuit lets launches that become
    // ready in the last moments of the timeout window actually succeed, and
    // lets callers pass sub-100ms timeouts without deterministic failure.
    attempts += 1;
    const probeTimeout = Math.min(remaining, DEBUG_PORT_MAX_HTTP_TIMEOUT_MS);
    const wsEndpoint = await checkDebugPort(port, probeTimeout);
    if (wsEndpoint) {
      return wsEndpoint;
    }

    // Periodic progress log for operator diagnostics on slow startups
    if (attempts % DEBUG_PORT_PROGRESS_LOG_INTERVAL === 0) {
      const elapsed = timeout - remaining;
      console.error(
        `[Launcher] Debug port ${port} not ready yet ` +
        `(attempt ${attempts}, elapsed ${elapsed}ms, remaining ${Math.max(0, deadline - Date.now())}ms)`
      );
    }

    // Cap backoff at both the per-iteration maximum and the remaining budget.
    // Remaining-1 ensures we always enter the next iteration past the deadline
    // check rather than burning the last millisecond in setTimeout.
    const remainingAfterProbe = deadline - Date.now();
    if (remainingAfterProbe <= 0) {
      throw new DebugPortTimeoutError(port, timeout, attempts);
    }
    const sleepFor = Math.min(backoff, DEBUG_PORT_MAX_BACKOFF_MS, Math.max(0, remainingAfterProbe - 1));
    if (sleepFor > 0) {
      await new Promise((r) => setTimeout(r, sleepFor));
    }
    backoff = Math.min(backoff * DEBUG_PORT_BACKOFF_FACTOR, DEBUG_PORT_MAX_BACKOFF_MS);
  }

  throw new DebugPortTimeoutError(port, timeout, attempts);
}

export interface ProfileState {
  type: ProfileType;             // from profile-manager: 'real' | 'persistent' | 'temp' | 'explicit'
  cookieCopiedAt?: number;       // timestamp when cookies were copied (undefined for real profile)
  extensionsAvailable: boolean;
  sourceProfile?: string;        // path to the real profile (if synced from)
  userDataDir?: string;          // actual userDataDir being used
  profileDirectory?: string;     // Chrome profile directory name (e.g., "Profile 1", "Default")
}

export class ChromeLauncher {
  private instance: ChromeInstance | null = null;
  private pendingProcess: ChildProcess | null = null;
  private launchInFlight: Promise<ChromeInstance> | null = null;
  private port: number;
  private profileManager = new ProfileManager();
  private currentProfileType: ProfileType | undefined;
  private profileState: ProfileState = {
    type: 'real',
    extensionsAvailable: true,
  };
  private _intentionalStop = false;
  /** ms timestamp of the most recent successful spawn, for #660 anti-flap. */
  private _chromeStartedAt = 0;
  /** Most recent exit classification (#660). 'intentional' | 'clean' | 'crash'. */
  private _lastExitClassification: ExitClassification | null = null;
  /** ms epoch until which the watchdog should skip relaunch (#660). 0 = no quiesce. */
  private _quiesceUntil = 0;
  /** Crash timestamps for the watchdog rate-limit check (#660 Phase 3). */
  private _recentCrashesMs: number[] = [];

  get intentionalStop(): boolean { return this._intentionalStop; }
  /** Last exit classification recorded by the spawn-side exit handler. */
  get lastExitClassification(): ExitClassification | null { return this._lastExitClassification; }
  /** Watchdog reads this; if `Date.now() < quiesceUntil` it skips relaunch. */
  get quiesceUntil(): number { return this._quiesceUntil; }
  /** Recent Chrome crash timestamps (last ~minute). */
  get recentCrashesMs(): readonly number[] { return this._recentCrashesMs; }
  /** Tools call this when they need Chrome — clears any pending quiesce. */
  clearQuiesce(): void { this._quiesceUntil = 0; }

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

    // Deduplicate concurrent ensureChrome() calls — return in-flight promise if one exists
    if (this.launchInFlight) {
      return this.launchInFlight;
    }

    this.launchInFlight = this.launchChrome(options).finally(() => {
      this.launchInFlight = null;
    });
    try {
      return await this.launchInFlight;
    } finally {
      this.launchInFlight = null;
    }
  }

  /**
   * Internal launch logic — called by ensureChrome() once the in-flight guard is acquired.
   */
  private async launchChrome(options: LaunchOptions = {}): Promise<ChromeInstance> {
    const port = options.port || this.port;

    // #659: resolve launch mode (auto / attach / isolated). Per-call options
    // win first (gemini high review on #670), then env, then config, then default 'auto'.
    const launchMode: ResolvedLaunchMode = resolveLaunchMode(
      { launchMode: options.launchMode },
      { OPENCHROME_LAUNCH_MODE: process.env.OPENCHROME_LAUNCH_MODE },
      { chromeLaunchMode: getGlobalConfig().chromeLaunchMode },
    );

    // 'isolated' mode: skip the existing-Chrome probe entirely. Always spawn
    // our own Chrome with our isolated user-data-dir. Used for clean-room
    // scraping where attaching to a stray developer Chrome would be wrong.
    //
    // codex P1 review on #670: a Chrome already bound to `port` would otherwise
    // be picked up by `waitForDebugPort` after our spawn (since Chrome silently
    // re-uses or rebinds), defeating the isolation guarantee. We do a tight
    // single-shot probe BEFORE spawning and refuse to start if the port is
    // taken — caller must clear the port or pick a different one.
    let existingWs: string | null = null;
    if (launchMode === 'isolated') {
      const occupied = await checkDebugPort(port, 500);
      if (occupied) {
        throw new Error(
          `[ChromeLauncher] launch mode 'isolated' but port ${port} is already in use ` +
            `by another Chrome (debug endpoint: ${occupied}). ` +
            `Stop that Chrome, choose a different --port, or set OPENCHROME_LAUNCH_MODE=auto to attach.`,
        );
      }
      console.error('[ChromeLauncher] Launch mode: isolated — skipping debug-port attach.');
    } else {
      // Check if Chrome is already running with debug port.
      // Use a brief retry window (5s) instead of a single-shot check, because Chrome
      // may still be binding the debug port during startup (1-5s window).
      existingWs = await waitForDebugPort(port, 5000).catch(() => null);
    }

    // 'attach' mode: must attach. If no debug port responded, surface a
    // structured error (no auto-restart per #659 policy decision #2).
    if (launchMode === 'attach' && !existingWs) {
      // Diagnostic: enumerate any running Chromes so the agent can hint at
      // the right CLI invocation. Read-only, never kills anything.
      try {
        const candidates = filterByProfile(
          detectRunningChromes(),
          options.profileDirectory,
        );
        const chosen = pickPreferredChrome(candidates);
        if (chosen) {
          console.error(
            `[ChromeLauncher] attach mode: detected Chrome (PID ${chosen.pid}, variant=${chosen.variant}) ` +
              `but it is not exposing --remote-debugging-port=${port}. ` +
              `openchrome will NOT auto-restart your Chrome. Re-launch it with --remote-debugging-port=${port}.`,
          );
        } else {
          console.error(`[ChromeLauncher] attach mode: no Chrome processes found.`);
        }
      } catch (err) {
        console.error(`[ChromeLauncher] attach mode: process detection failed:`, err);
      }
      throw new AttachConsentRequiredError(port);
    }

    if (existingWs) {
      const pendingProc = this.pendingProcess;
      this.pendingProcess = null;
      // codex P1 review on #670: when our prior spawn left a still-running
      // pendingProcess and the debug port is now responding, the responder is
      // almost certainly OUR Chrome — not a user-attached one. Tagging it as
      // 'attach' would make close() skip kill and leak our spawn. Treat as
      // isolated and register / write a marker so the lifecycle paths see it.
      const ourChromeRespondedLate = pendingProc !== null && pendingProc.exitCode === null;

      if (ourChromeRespondedLate) {
        console.error(`[ChromeLauncher] Pending Chrome (PID ${pendingProc!.pid}) responded on port ${port}; treating as our managed instance.`);
        // Best-effort sync-shutdown registration so #661 sync-kill can target
        // this Chrome. The marker file write happened on the original spawn
        // (the prior call that produced this pendingProcess), so we don't
        // need to re-write it here. userDataDir is not in scope at this
        // pre-resolution point of the launcher; the marker on disk already
        // carries it.
        if (pendingProc!.pid) {
          registerManagedChrome({ pid: pendingProc!.pid });
        }
        this.instance = {
          wsEndpoint: existingWs,
          httpEndpoint: `http://127.0.0.1:${port}`,
          process: pendingProc!,
          launchMode: 'isolated',
        };
      } else {
        console.error(`[ChromeLauncher] Found existing Chrome on port ${port}`);
        this.instance = {
          wsEndpoint: existingWs,
          httpEndpoint: `http://127.0.0.1:${port}`,
          // Connected to a Chrome we did not spawn — never kill on exit (#661 Phase 6).
          launchMode: 'attach',
        };
        // Attached to user-started Chrome — assume real profile
        this.profileState = { type: 'real', extensionsAvailable: true };
      }
      return this.instance;
    }

    // Reuse a still-starting Chrome process from a previous timed-out launch attempt.
    // This prevents spawning duplicate Chrome instances (issue #171).
    if (this.pendingProcess && this.pendingProcess.exitCode !== null) {
      // Pending process has already exited — clean it up
      this.pendingProcess = null;
    }
    if (this.pendingProcess && this.pendingProcess.exitCode === null) {
      console.error('[ChromeLauncher] Reusing pending Chrome process from previous launch attempt...');
      const launchTimeout = parseInt(process.env.CHROME_LAUNCH_TIMEOUT_MS || String(DEFAULT_CHROME_LAUNCH_TIMEOUT_MS), 10);
      const pendingProc = this.pendingProcess;
      try {
        const wsEndpoint = await waitForDebugPort(port, launchTimeout, pendingProc);
        this.pendingProcess = null;
        // codex P2 review on #670: this Chrome was spawned by us in a prior
        // attempt that timed out — register so #661 sync-kill paths can
        // target it. The marker file was already written by the original
        // spawn site; userDataDir isn't resolved yet at this branch so we
        // intentionally skip a re-write.
        if (pendingProc.pid) {
          registerManagedChrome({ pid: pendingProc.pid });
        }
        this.instance = {
          wsEndpoint,
          httpEndpoint: `http://127.0.0.1:${port}`,
          process: pendingProc,
          launchMode: 'isolated',
        };
        console.error(`[ChromeLauncher] Reused pending Chrome process, ready at ${wsEndpoint}`);
        return this.instance;
      } catch (err) {
        // Pending process failed too — kill it and fall through to fresh launch
        console.error('[ChromeLauncher] Pending Chrome process failed, will launch fresh');
        try { pendingProc.kill(); } catch { /* ignore */ }
        this.pendingProcess = null;
      }
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
    // Skip expensive isProfileLocked check when result won't be used:
    // explicit dir, temp profile, headless-shell, or no real profile.
    // Note: isAutoLaunch routes to persistent profile regardless of lock state,
    // but the lock check is still useful for cookie sync decisions in resolveProfile.
    const isLocked = (!explicitUserDataDir && !options.useTempProfile && !usingHeadlessShell && realProfileDir)
      ? this.isProfileLocked(realProfileDir)
      : false;

    const resolution = this.profileManager.resolveProfile({
      realProfileDir,
      isProfileLocked: isLocked,
      explicitUserDataDir,
      useTempProfile: options.useTempProfile,
      usingHeadlessShell,
      isAutoLaunch: true,  // Chrome 136+: force non-default --user-data-dir
    });

    const userDataDir = resolution.userDataDir;
    const profileType = resolution.profileType;
    this.currentProfileType = profileType;

    // Clean stale locks from persistent profile before launching Chrome.
    // After oc_stop force-kills Chrome, stale locks and crashed exit_type
    // can leave the profile in a degraded state.
    // Non-fatal: a stale lock is better than a failed launch.
    if (profileType === 'persistent') {
      try {
        const profileSubdir = options.profileDirectory || globalConfig.profileDirectory || 'Default';
        this.profileManager.cleanStaleLocks(userDataDir, profileSubdir);
      } catch (err) {
        console.error('[ChromeLauncher] cleanStaleLocks failed (non-fatal):', err);
      }
    }

    const profileDirectory = options.profileDirectory || globalConfig.profileDirectory;

    // Track profile state for MCP consumers
    this.profileState = {
      type: profileType,
      extensionsAvailable: profileType === 'real' || profileType === 'explicit',
      ...(resolution.syncPerformed && { cookieCopiedAt: Date.now() }),
      ...(realProfileDir && profileType === 'persistent' && { sourceProfile: realProfileDir }),
      userDataDir,
      ...(profileDirectory && { profileDirectory }),
    };

    if (resolution.syncPerformed) {
      console.error(`[ChromeLauncher] Using persistent profile with fresh cookie sync: ${userDataDir}`);
    } else if (profileType === 'persistent') {
      console.error(`[ChromeLauncher] Using persistent profile (cookies fresh): ${userDataDir}`);
    } else if (profileType === 'real') {
      console.error(`[ChromeLauncher] Using real Chrome profile: ${userDataDir}`);
    } else if (profileType === 'temp') {
      console.error(`[ChromeLauncher] Using temp profile: ${userDataDir}`);
    } else if (profileType === 'headless-shell') {
      console.error(`[ChromeLauncher] Using stable headless-shell profile: ${userDataDir}`);
    } else {
      console.error(`[ChromeLauncher] Using explicit profile: ${userDataDir}`);
    }

    fs.mkdirSync(userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
    ];

    if (profileDirectory) {
      args.push(`--profile-directory=${profileDirectory}`);
      console.error(`[ChromeLauncher] Using profile directory: ${profileDirectory}`);
    }

    // Tab restoration: opt-in for long sessions (#347 Phase 2A.3)
    const restoreSession = options.restoreLastSession
      ?? (process.env.OPENCHROME_RESTORE_LAST_SESSION !== undefined
          ? process.env.OPENCHROME_RESTORE_LAST_SESSION === 'true'
          : undefined)
      ?? globalConfig.restoreLastSession
      ?? DEFAULT_RESTORE_LAST_SESSION;

    // Headless mode: explicit option > global config (default when auto-launch)
    const headless = options.headless ?? globalConfig.headless ?? false;

    // Essential flags — required for all modes
    args.push(
      '--no-first-run',
      '--no-default-browser-check',
      restoreSession ? '--restore-last-session' : '--no-restore-last-session',
    );

    if (headless) {
      // Preserve the previous headless argument shape; headed window placement is handled below.
      args.push('--start-maximized', `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`);
    } else {
      args.push(...getHeadedWindowArgs({
        windowSize: options.windowSize ?? globalConfig.windowSize,
        windowPosition: options.windowPosition ?? globalConfig.windowPosition,
        windowBounds: options.windowBounds ?? globalConfig.windowBounds,
        startMaximized: options.startMaximized ?? globalConfig.startMaximized,
      }));
    }

    // Prevent Blink from setting navigator.webdriver = true when CDP is connected.
    // Without this, anti-automation systems (e.g., Cloudflare Turnstile) detect the
    // browser as automated and refuse to function — even for manual human interaction.
    // This is an official Chrome flag, not a stealth hack. (#247)
    // Skipped for chrome-headless-shell which may not support this flag.
    if (!usingHeadlessShell) {
      args.push('--disable-blink-features=AutomationControlled');
    }

    // Stability flags — suppress crash UI that blocks automation in long sessions (#347).
    // Applied only to managed profiles; real profiles retain stock Chrome behavior
    // to minimize fingerprint divergence.
    if (profileType !== 'real') {
      args.push(
        '--disable-backgrounding-occluded-windows',
        // Prevent Chrome from self-terminating after repeated GPU crashes (headed mode)
        '--disable-gpu-crash-limit',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
      );
    }

    // NOTE: The following flags were removed as known bot-detection signals
    // per Patchright and undetected-chromedriver analysis (#257, #453):
    //   --disable-background-networking  (Akamai/Imperva fingerprint signal)
    //   --disable-sync                   (automation fingerprint signal)
    //   --disable-translate              (automation fingerprint signal)
    //   --renderer-process-limit=N       (non-standard, reveals automation)
    //   --js-flags=--max-old-space-size  (non-standard V8 config)
    //   --disable-crash-reporter         (automation fingerprint signal)

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
      stdio: ['ignore', 'ignore', 'pipe'],
      // shell: false is safe on all platforms; avoids cmd.exe injection risks on Windows
    });

    // Capture stderr for diagnostics (Chrome writes "DevTools listening on ws://..." and errors here)
    const stderrChunks: string[] = [];
    if (chromeProcess.stderr) {
      chromeProcess.stderr.setEncoding('utf8');
      chromeProcess.stderr.on('data', (data: string) => {
        stderrChunks.push(data);
        // Keep only last 20 lines to bound memory
        if (stderrChunks.length > 20) stderrChunks.shift();
      });
    }

    chromeProcess.unref();
    // Note: On Windows, detached processes create a new process group.
    // Killing the root process may not clean up child processes (renderers, GPU).
    // The oc_stop tool handles this via session/pool cleanup before process kill.
    if (chromeProcess.pid) {
      spawnProcessGuardian(process.pid, chromeProcess.pid, {
        pidFilePath: getChromePidFilePath(port),
        label: 'managed-chrome',
      });
      // #661 Phase 1+2 (gemini high review): write the ownership marker AND
      // register for synchronous shutdown immediately after spawn — before
      // waitForDebugPort. Otherwise, if the parent dies during the debug-port
      // wait window, the orphaned Chrome would not be in the registry and
      // would leak.
      if (userDataDir) {
        writeMarker({ chromePid: chromeProcess.pid, userDataDir });
      }
      registerManagedChrome({ pid: chromeProcess.pid, userDataDir });
    }

    // Log Chrome process exit and classify it for the watchdog (#660).
    const chromeStartedAtForExitHandler = Date.now();
    chromeProcess.once('exit', (code, signal) => {
      const uptimeMs = Date.now() - chromeStartedAtForExitHandler;
      const classification = classifyExit({
        code,
        signal,
        uptimeMs,
        intentionalStop: this._intentionalStop,
      });
      this._lastExitClassification = classification;
      console.error(
        `[ChromeLauncher] Chrome process exited (code: ${code}, signal: ${signal}, uptime: ${uptimeMs}ms, class: ${classification})`,
      );
      // Symmetric cleanup: unregister + remove marker so a failed-launch Chrome
      // (e.g. waitForDebugPort timeout) does not leave stale state behind.
      if (chromeProcess.pid) {
        unregisterManagedChrome(chromeProcess.pid);
        removeMarker({ chromePid: chromeProcess.pid, userDataDir });
      }
      if (classification === 'clean' && !this._intentionalStop) {
        // User-driven close. Quiesce the watchdog so it does not silently respawn (#660).
        const quiesce = quiesceMs();
        this._quiesceUntil = Date.now() + quiesce;
        console.error(`[ChromeLauncher] Quiesced relaunch for ${quiesce}ms (user-driven close)`);
      } else if (classification === 'crash') {
        // Track for rate-limit check.
        this._recentCrashesMs.push(Date.now());
        // Bound the array — only last ~10 entries needed.
        if (this._recentCrashesMs.length > 10) {
          this._recentCrashesMs = this._recentCrashesMs.slice(-10);
        }
      }
      // Clear cached instance so next ensureChrome() knows Chrome is gone
      this.instance = null;
      // Clear pendingProcess if this was the one we were tracking
      if (this.pendingProcess === chromeProcess) {
        this.pendingProcess = null;
      }
    });

    // Track as pending for retry reuse (issue #171)
    this.pendingProcess = chromeProcess;

    const launchTimeout = parseInt(process.env.CHROME_LAUNCH_TIMEOUT_MS || String(DEFAULT_CHROME_LAUNCH_TIMEOUT_MS), 10);

    // Wait for debug port — pass chromeProcess for fast-fail on premature exit.
    // On timeout, pendingProcess is intentionally kept set so the next call can
    // reuse the still-starting Chrome instead of spawning a duplicate (issue #171).
    let wsEndpoint: string;
    try {
      wsEndpoint = await waitForDebugPort(port, launchTimeout, chromeProcess);
    } catch (err) {
      const stderr = stderrChunks.join('').trim();
      const diagnostics = [
        `Chrome debug port ${port} not available after ${launchTimeout}ms`,
        `  OS: ${os.platform()} ${os.arch()} ${os.release()}`,
        `  Chrome: ${chromePath}`,
        `  Profile: ${userDataDir} (${profileType})`,
        `  PID: ${chromeProcess.pid ?? 'unknown'}`,
        `  Exit code: ${chromeProcess.exitCode ?? 'still running'}`,
      ];
      if (stderr) {
        diagnostics.push(`  Stderr: ${stderr.slice(-500)}`);
      } else {
        diagnostics.push('  Stderr: (empty — Chrome may have failed to start)');
      }
      diagnostics.push('');
      diagnostics.push('Common causes:');
      diagnostics.push('  - Another Chrome instance is using the same --user-data-dir (profile lock)');
      diagnostics.push('  - Port conflict: another process is bound to port ' + port);
      diagnostics.push('  - Firewall/antivirus blocking localhost connections');
      diagnostics.push('  - Chrome 136+: requires --user-data-dir with --remote-debugging-port');
      throw new Error(diagnostics.join('\n'));
    }
    this.pendingProcess = null; // Success — no longer pending

    // Marker + registration already happened immediately after spawn (above).
    // Here we just record the instance state.
    this.instance = {
      wsEndpoint,
      httpEndpoint: `http://127.0.0.1:${port}`,
      process: chromeProcess,
      userDataDir,
      profileType,
      launchMode: 'isolated',
    };

    // Persist Chrome PID to disk for orphan detection
    if (chromeProcess.pid) {
      writeChromePid(port, chromeProcess.pid);
    }

    this._intentionalStop = false;
    // Successful launch — clear any pending quiesce (#660).
    this._quiesceUntil = 0;
    this._chromeStartedAt = Date.now();
    console.error(`[ChromeLauncher] Chrome ready at ${wsEndpoint}`);
    return this.instance;
  }

  /**
   * Get the current Chrome instance (for process watchdog).
   * Returns null if Chrome is not running or not launched by us.
   */
  getInstance(): ChromeInstance | null {
    return this.instance;
  }

  /**
   * Whether Chrome is currently in the process of launching.
   */
  isLaunching(): boolean {
    return this.pendingProcess !== null || this.launchInFlight !== null;
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
    this._intentionalStop = true;
    if (this.pendingProcess) {
      try { this.pendingProcess.kill(); } catch { /* ignore */ }
      this.pendingProcess = null;
    }
    // Attach mode (#659, #661 Phase 6): we did not spawn this Chrome — never kill it.
    if (this.instance?.launchMode === 'attach') {
      console.error('[ChromeLauncher] close(): attach-mode Chrome left alive (user-owned).');
      this.instance = null;
      return;
    }
    if (this.instance?.process) {
      console.error('[ChromeLauncher] Closing Chrome...');
      const proc = this.instance.process;
      const userDataDir = this.instance.userDataDir;
      const profileType = this.currentProfileType;
      const chromePidForMarker = proc.pid;

      if (process.platform === 'win32' && proc.pid) {
        try {
          // On Windows, kill the entire process tree to clean up renderer/GPU children
          execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: 'ignore' });
          console.error(`[ChromeLauncher] Windows: killed process tree for PID ${proc.pid}`);
        } catch {
          // Fallback to regular kill if taskkill fails
          proc.kill();
        }
      } else {
        killProcessTree(proc.pid ?? 0, 'SIGTERM');
      }

      // Wait for the process to actually exit before clearing state.
      // This prevents port conflicts on rapid stop/restart cycles where
      // the old Chrome may still be binding the debug port when a new
      // instance starts.
      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          try {
            if (process.platform === 'win32') {
              proc.kill();
            } else {
              killProcessTree(proc.pid ?? 0, 'SIGKILL');
            }
          } catch {
            // Process may have already exited
          }
          resolve();
        }, 5000);
        forceKillTimer.unref();

        proc.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });

        // If the process already exited (exitCode is set), resolve immediately
        if (proc.exitCode !== null || proc.killed) {
          clearTimeout(forceKillTimer);
          resolve();
        }
      });

      // Clean up user data dir — only delete temp profiles.
      // Persistent profiles survive across sessions; real/explicit profiles are never ours to delete.
      if (userDataDir && profileType === 'temp') {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
          console.error(`[ChromeLauncher] Cleaned up temp profile: ${userDataDir}`);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Remove ownership marker (#661 Phase 1).
      if (chromePidForMarker) {
        removeMarker({ chromePid: chromePidForMarker, userDataDir });
        unregisterManagedChrome(chromePidForMarker);
      }
    }
    // Remove Chrome PID file before clearing instance
    removeChromePid(this.port);
    this.instance = null;
  }

  /**
   * Get the PID of the managed Chrome process (if any).
   * Checks both the active instance and the pending (still-launching) process.
   */
  getChromePid(): number | undefined {
    return this.instance?.process?.pid ?? this.pendingProcess?.pid ?? undefined;
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
  private isProfileLocked(profileDir: string, platformOverride?: string): boolean {
    const platform = platformOverride || os.platform();
    if (platform === 'win32') {
      // Windows Chrome uses a 'lockfile' in the user data directory
      const lockFile = path.join(profileDir, 'lockfile');
      if (fs.existsSync(lockFile)) {
        console.error(`[ChromeLauncher] Profile locked: ${lockFile} exists`);
        return true;
      }

      // Lockfile may not exist even when Chrome is running (race condition
      // or different Chrome version behavior). Cross-check by looking for
      // chrome.exe processes that have this profile directory open.
      try {
        const output = execSync(
          'wmic process where "name=\'chrome.exe\'" get CommandLine 2>nul',
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
        );
        // Normalize path separators for comparison (forward-slash on both sides)
        const normalizedProfileDir = profileDir.replace(/\\/g, '/').toLowerCase();
        const normalizedOutput = output.replace(/\\/g, '/').toLowerCase();
        if (normalizedOutput.includes(normalizedProfileDir)) {
          console.error(`[ChromeLauncher] Profile locked: chrome.exe running with ${profileDir}`);
          return true;
        }
      } catch {
        // wmic failed or not available (Windows 11 removed wmic) — try PowerShell fallback
        try {
          const psOutput = execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'chrome.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }
          );
          if (psOutput.toLowerCase().includes(profileDir.toLowerCase())) {
            console.error(`[ChromeLauncher] Profile locked: chrome.exe running with ${profileDir} (PowerShell)`);
            return true;
          }
        } catch {
          // Both wmic and PowerShell failed — fall back to simple process check.
          // This is less precise (can't verify the specific profile) but better
          // than nothing: if Chrome is running at all, the default profile is likely locked.
          try {
            const tasklistOutput = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 5000,
            });
            if (tasklistOutput.toLowerCase().includes('chrome.exe')) {
              // Chrome is running but we can't determine which profile.
              // If profileDir is the default Chrome directory, assume locked.
              const defaultDir = this.getRealChromeProfileDir();
              if (defaultDir && path.normalize(profileDir).toLowerCase() === path.normalize(defaultDir).toLowerCase()) {
                console.error(`[ChromeLauncher] Profile likely locked: chrome.exe running and profileDir is the default Chrome directory`);
                return true;
              }
            }
          } catch {
            // tasklist also failed — cannot determine, assume not locked
          }
        }
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
