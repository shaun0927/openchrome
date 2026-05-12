/**
 * Auto-connect via DevToolsActivePort (#849).
 *
 * Locates `<userDataDir>/DevToolsActivePort` (a Chrome-managed two-line file
 * containing `<port>\n<browser-target-path>`), validates the port is bound,
 * and returns enough information for the existing attach path to take over.
 *
 * Inspired by chrome-devtools-mcp `--autoConnect` (Apache-2.0); openchrome's
 * implementation is independent.
 *
 * Boundary contract:
 *   - Refuses to attach to openchrome's own managed profile
 *     (`~/.openchrome/profile/`) — that path always uses launch mode.
 *   - Refuses with a stale-file error if `DevToolsActivePort` is older than
 *     60 s and the port is not bound (Chrome already shut down).
 *   - Polls up to `timeoutMs` (default 5000 ms) for the file to appear when
 *     missing — supports the common "Chrome is still starting" race.
 *   - Probes the port via `net.connect` before returning so the caller never
 *     hands back an endpoint that won't accept a CDP handshake.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export type ChromeChannel = 'stable' | 'beta' | 'dev' | 'canary';

export interface AutoConnectOptions {
  /** Explicit Chrome user-data dir to scan. Defaults to platform / channel default. */
  userDataDir?: string;
  /** Chrome release channel — used only when `userDataDir` is omitted. */
  channel?: ChromeChannel;
  /** Total wall-time budget waiting for `DevToolsActivePort` to appear. */
  timeoutMs?: number;
  /** Override for tests — defaults to `~/.openchrome/profile`. */
  managedProfileDir?: string;
  /** Override for tests — defaults to `Date.now`. */
  now?: () => number;
}

export interface AutoConnectResult {
  /** ws://127.0.0.1:<port><browser-target-path>. */
  wsEndpoint: string;
  port: number;
  /** The browser-target path Chrome wrote on line 2 of the file. */
  browserTargetPath: string;
  /** Resolved user-data dir (after channel / default fallback). */
  userDataDir: string;
}

export class AutoConnectError extends Error {
  readonly errorCode:
    | 'managed_profile_refused'
    | 'devtools_active_port_missing'
    | 'devtools_active_port_malformed'
    | 'port_not_bound'
    | 'stale_active_port_file'
    | 'invalid_user_data_dir';

  constructor(
    message: string,
    code:
      | 'managed_profile_refused'
      | 'devtools_active_port_missing'
      | 'devtools_active_port_malformed'
      | 'port_not_bound'
      | 'stale_active_port_file'
      | 'invalid_user_data_dir',
  ) {
    super(message);
    this.name = 'AutoConnectError';
    this.errorCode = code;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const STALE_FILE_THRESHOLD_MS = 60_000;
const PORT_PROBE_TIMEOUT_MS = 1500;
const POLL_INTERVAL_MS = 100;

/**
 * Default Chrome user-data dir per platform / channel.
 *
 * NOTE: This intentionally does NOT cover every browser variant. The issue
 * scope (#849) keeps the discovery surface small — operators with unusual
 * setups must pass `--auto-connect=<dir>` explicitly.
 */
export function defaultUserDataDir(channel: ChromeChannel = 'stable'): string | null {
  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    const variant = chromeVariant(channel);
    return path.join(home, 'Library', 'Application Support', 'Google', variant);
  }

  if (platform === 'win32') {
    // Windows: %LOCALAPPDATA%\Google\Chrome[ Beta|Dev|SxS]\User Data
    const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    const variant = chromeVariant(channel);
    return path.join(localAppData, 'Google', variant, 'User Data');
  }

  // Linux: ~/.config/google-chrome[-beta|-unstable] (no canary on Linux)
  if (channel === 'beta') return path.join(home, '.config', 'google-chrome-beta');
  if (channel === 'dev') return path.join(home, '.config', 'google-chrome-unstable');
  if (channel === 'canary') return null;
  return path.join(home, '.config', 'google-chrome');
}

function chromeVariant(channel: ChromeChannel): string {
  switch (channel) {
    case 'beta':
      return 'Chrome Beta';
    case 'dev':
      return 'Chrome Dev';
    case 'canary':
      return 'Chrome Canary';
    default:
      return 'Chrome';
  }
}

function managedProfileDir(): string {
  return path.join(os.homedir(), '.openchrome', 'profile');
}

function normalize(p: string): string {
  return path.resolve(p);
}

/**
 * Probe whether `port` accepts a TCP connection on 127.0.0.1.
 * Resolves true on connect, false on error/timeout.
 */
function probePort(port: number, timeoutMs: number = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    try {
      socket.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

interface ParsedActivePort {
  port: number;
  browserTargetPath: string;
}

function parseDevToolsActivePort(raw: string): ParsedActivePort {
  // Chrome writes two lines: <port>\n<browser-target-path>. Tolerate trailing
  // whitespace and an optional trailing newline. Browser-target-path may be
  // empty (older Chrome), in which case we default to '/'.
  const lines = raw.split(/\r?\n/);
  const portLine = (lines[0] ?? '').trim();
  const port = parseInt(portLine, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new AutoConnectError(
      `DevToolsActivePort first line is not a valid TCP port: "${portLine}"`,
      'devtools_active_port_malformed',
    );
  }
  const targetPath = (lines[1] ?? '').trim() || '/';
  // Browser target path Chrome writes always starts with `/`. Defensive guard.
  const browserTargetPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return { port, browserTargetPath };
}

async function waitForFile(
  filePath: string,
  timeoutMs: number,
  now: () => number,
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new AutoConnectError(
    `DevToolsActivePort not found at ${filePath} after ${timeoutMs}ms. ` +
      `Is Chrome running with --remote-debugging-port and --user-data-dir pointed at this directory?`,
    'devtools_active_port_missing',
  );
}

/**
 * Locate the active DevTools endpoint for a Chrome instance the user
 * launched themselves. See module-level comment for the full contract.
 */
export async function discoverActiveDevToolsPort(
  opts: AutoConnectOptions = {},
): Promise<AutoConnectResult> {
  const now = opts.now ?? Date.now;
  const channel = opts.channel ?? 'stable';

  // 1. Resolve userDataDir.
  let userDataDir: string;
  if (opts.userDataDir && opts.userDataDir.trim() !== '') {
    userDataDir = normalize(opts.userDataDir);
  } else {
    const fallback = defaultUserDataDir(channel);
    if (!fallback) {
      throw new AutoConnectError(
        `No default Chrome user-data dir for channel "${channel}" on ${os.platform()}; ` +
          `pass --auto-connect=<dir> explicitly.`,
        'invalid_user_data_dir',
      );
    }
    userDataDir = normalize(fallback);
  }

  // 2. Refuse openchrome's managed profile. The two paths must never overlap;
  //    the managed profile is launched, never attached. Compare normalised
  //    paths so trailing slashes / .. segments don't bypass the guard.
  const managed = normalize(opts.managedProfileDir ?? managedProfileDir());
  if (userDataDir === managed) {
    throw new AutoConnectError(
      `Refusing to auto-connect to openchrome's managed profile (${managed}). ` +
        `That profile is owned by openchrome and is only valid in launch mode. ` +
        `Pass --auto-connect=<other-dir> for an externally-launched Chrome.`,
      'managed_profile_refused',
    );
  }

  // 3. Read DevToolsActivePort (poll if absent).
  const filePath = path.join(userDataDir, 'DevToolsActivePort');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!fs.existsSync(filePath)) {
    await waitForFile(filePath, timeoutMs, now);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AutoConnectError(
      `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      'devtools_active_port_missing',
    );
  }

  const { port, browserTargetPath } = parseDevToolsActivePort(raw);

  // 4. Validate the port is actually bound.
  const bound = await probePort(port);
  if (!bound) {
    // Stale-file detection: if the file is older than 60 s and the probe
    // failed, surface the more precise stale-file error so operators stop
    // chasing missing-Chrome ghosts.
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    const age = mtimeMs > 0 ? now() - mtimeMs : 0;
    if (mtimeMs > 0 && age > STALE_FILE_THRESHOLD_MS) {
      throw new AutoConnectError(
        `DevToolsActivePort at ${filePath} reports port ${port} but nothing is listening, ` +
          `and the file is ${Math.round(age / 1000)}s old (>60s). ` +
          `Chrome appears to have shut down without cleaning up the file. ` +
          `Delete the file and re-launch Chrome with --remote-debugging-port=0.`,
        'stale_active_port_file',
      );
    }
    throw new AutoConnectError(
      `DevToolsActivePort at ${filePath} reports port ${port} but nothing is listening on 127.0.0.1:${port}. ` +
        `Chrome may have crashed, or another process may be holding the file. Re-launch Chrome and retry.`,
      'port_not_bound',
    );
  }

  return {
    wsEndpoint: `ws://127.0.0.1:${port}${browserTargetPath}`,
    port,
    browserTargetPath,
    userDataDir,
  };
}

/**
 * Internal helper: pure fns exported for unit tests.
 * Keep parsing deterministic and side-effect free.
 */
export const __testing = {
  parseDevToolsActivePort,
  defaultUserDataDir,
  probePort,
};
