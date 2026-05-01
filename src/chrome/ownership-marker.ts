/**
 * Ownership-marker file (#661).
 *
 * When openchrome spawns a Chrome process *that it owns*, it writes a marker
 * inside the Chrome `--user-data-dir` (or, as a fallback, under the openchrome
 * state dir). The marker is the source of truth for orphan reaping: only kill
 * Chrome processes whose marker UUID we recognize.
 *
 * Crucially, attach-mode Chrome (issue #659) never gets a marker — that
 * process belongs to the user and must never be killed by openchrome.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const MARKER_FILENAME = '.openchrome-managed';
const STATE_DIR = path.join(os.homedir(), '.openchrome', 'state', 'markers');

const LOG_PREFIX = '[openchrome:marker]';

export interface OwnershipMarker {
  /** Chrome process PID. */
  pid: number;
  /** Parent (MCP server) PID at marker write time. */
  ppid: number;
  /** Command line of the parent process at write time, for PID-reuse detection. */
  ppidCommand: string;
  /** Absolute path of the user-data-dir we passed to Chrome. */
  userDataDir: string;
  /** ISO timestamp. */
  startedAt: string;
  /** Random per-launch UUID. Used to disambiguate PID reuse. */
  marker: string;
  /** Lifecycle ownership: 'isolated' = we spawned and own the lifecycle. Attach mode does not write a marker at all. */
  launchMode: 'isolated';
}

/**
 * Read a process's command-line. Linux only reads from /proc; on macOS/Windows
 * we have no portable cheap way, so we fall back to the current process's argv —
 * but only when the requested pid IS the current process. For any other pid
 * we return '' rather than misleading data (gemini medium review on #667).
 */
export function readParentCommand(pid: number): string {
  if (process.platform === 'linux') {
    try {
      // /proc/<pid>/cmdline is NUL-separated; never truncated.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw.replace(/\0/g, ' ').trim();
    } catch {
      return '';
    }
  }
  // Best-effort across non-Linux platforms; only valid for the current process.
  if (pid === process.pid) {
    return process.argv.join(' ');
  }
  return '';
}

function primaryMarkerPath(userDataDir: string): string {
  return path.join(userDataDir, MARKER_FILENAME);
}

function fallbackMarkerPath(pid: number): string {
  return path.join(STATE_DIR, `${pid}.json`);
}

function ensureStateDir(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error(`${LOG_PREFIX} Failed to create state dir ${STATE_DIR}:`, err);
    }
  }
}

/**
 * Write a marker for an isolated-mode Chrome process.
 * Returns the generated UUID, or null if the write failed in both locations
 * (in which case the caller should still continue — orphan-reaping just
 * loses some accuracy for that one Chrome).
 */
export function writeMarker(opts: {
  chromePid: number;
  userDataDir: string;
}): string | null {
  const marker: OwnershipMarker = {
    pid: opts.chromePid,
    ppid: process.pid,
    ppidCommand: readParentCommand(process.pid),
    userDataDir: path.resolve(opts.userDataDir),
    startedAt: new Date().toISOString(),
    marker: randomUUID(),
    launchMode: 'isolated',
  };

  const payload = JSON.stringify(marker, null, 2);

  // Primary: inside the user-data-dir (co-located with Chrome's profile).
  try {
    fs.writeFileSync(primaryMarkerPath(opts.userDataDir), payload, { encoding: 'utf8' });
    return marker.marker;
  } catch (err) {
    console.error(`${LOG_PREFIX} Primary marker write failed (${primaryMarkerPath(opts.userDataDir)}):`, err);
  }

  // Fallback: openchrome state dir, keyed by Chrome PID.
  try {
    ensureStateDir();
    fs.writeFileSync(fallbackMarkerPath(opts.chromePid), payload, { encoding: 'utf8' });
    return marker.marker;
  } catch (err) {
    console.error(`${LOG_PREFIX} Fallback marker write failed:`, err);
    return null;
  }
}

/**
 * Best-effort marker removal. Looks at both the primary and fallback paths.
 */
export function removeMarker(opts: { chromePid: number; userDataDir?: string }): void {
  if (opts.userDataDir) {
    try {
      fs.unlinkSync(primaryMarkerPath(opts.userDataDir));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`${LOG_PREFIX} Failed to remove primary marker:`, err);
      }
    }
  }
  try {
    fs.unlinkSync(fallbackMarkerPath(opts.chromePid));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to remove fallback marker:`, err);
    }
  }
}

export function readMarker(filePath: string): OwnershipMarker | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OwnershipMarker>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.ppid !== 'number' ||
      typeof parsed.ppidCommand !== 'string' ||
      typeof parsed.userDataDir !== 'string' ||
      typeof parsed.marker !== 'string' ||
      parsed.launchMode !== 'isolated'
    ) {
      return null;
    }
    return parsed as OwnershipMarker;
  } catch {
    return null;
  }
}

/**
 * Discover all known markers.
 * - Primary: walks `~/.openchrome/profiles/*` for `.openchrome-managed` files.
 * - Fallback: every `~/.openchrome/state/markers/*.json`.
 * Custom user-data-dirs that live elsewhere are NOT scanned (we only know
 * about ones we wrote into our own profile root).
 */
export function listMarkers(): Array<{ filePath: string; marker: OwnershipMarker }> {
  const out: Array<{ filePath: string; marker: OwnershipMarker }> = [];

  const profilesRoot = path.join(os.homedir(), '.openchrome', 'profiles');
  try {
    const entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(profilesRoot, entry.name, MARKER_FILENAME);
      const m = readMarker(candidate);
      if (m) out.push({ filePath: candidate, marker: m });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to list profile markers:`, err);
    }
  }

  try {
    const entries = fs.readdirSync(STATE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const candidate = path.join(STATE_DIR, entry.name);
      const m = readMarker(candidate);
      if (m) out.push({ filePath: candidate, marker: m });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to list fallback markers:`, err);
    }
  }

  return out;
}

export function deleteMarkerFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to remove marker ${filePath}:`, err);
    }
  }
}

/**
 * Verify that a still-running PID is actually the same Chrome we tracked.
 * Mismatch → caller should leave the process alone (PID reuse).
 *
 * On Linux the cmdline is read directly. On macOS we use `ps -ww` so the
 * full --user-data-dir argument isn't truncated. On Windows we leave the
 * check unimplemented and return false (do not kill on Windows orphan
 * reaper for now; rely on the Phase-2 sync kill at exit).
 */
export function verifyChromePidIdentity(pid: number, expectedUserDataDir: string): boolean {
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const argv = raw.split('\0').filter((s) => s.length > 0);
      const exact = `--user-data-dir=${expectedUserDataDir}`;
      // Path separator matters: a bare startsWith allows /tmp/chrome to match
      // /tmp/chrome-2 (gemini medium / codex P2 review on #667).
      const sepPrefix = `--user-data-dir=${expectedUserDataDir}${path.sep}`;
      return argv.some((arg) => arg === exact || arg.startsWith(sepPrefix));
    } catch {
      return false;
    }
  }
  if (process.platform === 'darwin') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require('child_process');
      const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // ps -ww output is a single line for one PID.
      const cmdline = out.toString().trim();
      const exact = `--user-data-dir=${expectedUserDataDir}`;
      const sepPrefix = `--user-data-dir=${expectedUserDataDir}${path.sep}`;
      // Same separator-aware match as the Linux path; reject prefix collisions
      // like /tmp/chrome ↔ /tmp/chrome-2 (codex P2 review on #667).
      const matches =
        cmdline.includes(`${exact} `) ||
        cmdline.endsWith(exact) ||
        cmdline.includes(sepPrefix);
      if (!matches) {
        // No match — could be PID reuse, or could be macOS truncation despite -ww.
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  // Windows: skip identity check; refuse to kill via reaper to stay safe.
  return false;
}
