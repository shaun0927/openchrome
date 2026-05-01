/**
 * Cross-platform Chrome process detection (#659, read-only).
 *
 * Used for diagnostics and informational logging only. Does NOT modify or
 * terminate any process — that's the user's daily-driver Chrome.
 *
 * Supported platforms:
 *   macOS  : `ps -ww -ax -o pid,command`
 *   Linux  : `/proc/<pid>/cmdline`
 *   Windows: `wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:list`
 *
 * The shape of the output is stable across platforms: `DetectedChrome[]`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const LOG_PREFIX = '[openchrome:process-detector]';

export interface DetectedChrome {
  pid: number;
  /** Full command line, joined by single spaces. */
  cmdline: string;
  /** Best-effort variant classification, lowercased. */
  variant: ChromeVariant;
  /** `--profile-directory=...` value if present in the command line, else null. */
  profileDirectory: string | null;
  /** `--user-data-dir=...` value if present, else null. */
  userDataDir: string | null;
  /** Has --remote-debugging-port flag in the command line. */
  hasDebugPort: boolean;
}

export type ChromeVariant = 'stable' | 'beta' | 'canary' | 'chromium' | 'unknown';

/**
 * Variant priority for multi-variant tiebreakers (lower = higher priority).
 * Per #659 policy decision: Stable > Beta > Canary > Chromium, with lowest
 * PID as final tiebreaker.
 */
export const VARIANT_PRIORITY: Record<ChromeVariant, number> = {
  stable: 0,
  beta: 1,
  canary: 2,
  chromium: 3,
  unknown: 4,
};

function classifyVariant(cmdline: string): ChromeVariant {
  const lower = cmdline.toLowerCase();
  if (lower.includes('canary')) return 'canary';
  if (lower.includes('beta')) return 'beta';
  if (lower.includes('chromium')) return 'chromium';
  // "Google Chrome" without modifiers is stable (cover macOS path + linux package).
  if (lower.includes('google chrome') || lower.includes('google-chrome')) return 'stable';
  if (lower.includes('chrome.exe')) return 'stable';
  return 'unknown';
}

function extractFlag(cmdline: string, flag: string): string | null {
  // Match either `--flag=value` (with value possibly quoted) or `--flag value`.
  const eqRe = new RegExp(`--${flag}=("([^"]*)"|'([^']*)'|\\S+)`);
  const m = cmdline.match(eqRe);
  if (m) {
    return m[2] || m[3] || m[1].replace(/^['"]|['"]$/g, '');
  }
  const spaceRe = new RegExp(`--${flag}\\s+("([^"]*)"|'([^']*)'|\\S+)`);
  const m2 = cmdline.match(spaceRe);
  if (m2) return m2[2] || m2[3] || m2[1].replace(/^['"]|['"]$/g, '');
  return null;
}

function parseCmdline(pid: number, cmdline: string): DetectedChrome {
  return {
    pid,
    cmdline,
    variant: classifyVariant(cmdline),
    profileDirectory: extractFlag(cmdline, 'profile-directory'),
    userDataDir: extractFlag(cmdline, 'user-data-dir'),
    hasDebugPort: /--remote-debugging-port[=\s]/.test(cmdline),
  };
}

function detectMacOs(): DetectedChrome[] {
  try {
    const out = execFileSync('ps', ['-ww', '-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const result: DetectedChrome[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Match leading PID
      const m = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const cmd = m[2];
      // Filter to Chrome / Chromium binaries (case-insensitive).
      if (!/Chrome\.app|Chromium\.app|Google Chrome|chrome|chromium/i.test(cmd)) continue;
      // Skip the Helper / Renderer subprocesses — we want the main browser.
      if (/Chrome Helper|Chromium Helper/.test(cmd)) continue;
      result.push(parseCmdline(pid, cmd));
    }
    return result;
  } catch (err) {
    console.error(`${LOG_PREFIX} macOS detection failed:`, err);
    return [];
  }
}

function detectLinux(): DetectedChrome[] {
  try {
    const result: DetectedChrome[] = [];
    const procEntries = fs.readdirSync('/proc');
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      let raw: string;
      try {
        raw = fs.readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8');
      } catch {
        continue;
      }
      const cmd = raw.replace(/\0/g, ' ').trim();
      if (!cmd) continue;
      if (!/(google-chrome|chromium|chrome)/i.test(cmd)) continue;
      // Skip helpers / sandbox children — match the main browser only.
      if (/--type=/.test(cmd)) continue;
      result.push(parseCmdline(pid, cmd));
    }
    return result;
  } catch (err) {
    console.error(`${LOG_PREFIX} Linux detection failed:`, err);
    return [];
  }
}

function detectWindows(): DetectedChrome[] {
  try {
    const out = execFileSync(
      'wmic',
      ['process', 'where', "name='chrome.exe'", 'get', 'ProcessId,CommandLine', '/format:list'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const result: DetectedChrome[] = [];
    let cmd = '';
    let pid: number | null = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('CommandLine=')) {
        cmd = line.substring('CommandLine='.length);
      } else if (line.startsWith('ProcessId=')) {
        pid = parseInt(line.substring('ProcessId='.length), 10) || null;
      } else if (line.trim() === '' && cmd && pid !== null) {
        // Skip helpers
        if (!/--type=/.test(cmd)) {
          result.push(parseCmdline(pid, cmd));
        }
        cmd = '';
        pid = null;
      }
    }
    return result;
  } catch (err) {
    console.error(`${LOG_PREFIX} Windows detection failed:`, err);
    return [];
  }
}

export function detectRunningChromes(): DetectedChrome[] {
  switch (process.platform) {
    case 'darwin':
      return detectMacOs();
    case 'linux':
      return detectLinux();
    case 'win32':
      return detectWindows();
    default:
      return [];
  }
}

/**
 * Pick the "best" candidate when multiple Chromes match a profile request.
 * Per #659 policy:
 *   1. Variant priority: Stable > Beta > Canary > Chromium > Unknown.
 *   2. Lowest PID as tiebreaker.
 *
 * Returns `null` for an empty input.
 */
export function pickPreferredChrome(candidates: ReadonlyArray<DetectedChrome>): DetectedChrome | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const va = VARIANT_PRIORITY[a.variant];
    const vb = VARIANT_PRIORITY[b.variant];
    if (va !== vb) return va - vb;
    return a.pid - b.pid;
  });
  return sorted[0];
}

/**
 * Filter `candidates` down to those matching the requested profile.
 * Empty `requestedProfile` matches all candidates (caller decides what to do).
 */
export function filterByProfile(
  candidates: ReadonlyArray<DetectedChrome>,
  requestedProfile?: string,
): DetectedChrome[] {
  if (!requestedProfile) return [...candidates];
  return candidates.filter((c) => c.profileDirectory === requestedProfile);
}
