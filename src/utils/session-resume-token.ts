/**
 * Session-resume tokens (#661 Phase 7).
 *
 * When the agent calls `oc_session_snapshot` (or `oc_checkpoint`) intending
 * to restart MCP later via `oc_session_resume`, openchrome writes a token
 * file. Existence of the token tells the synchronous shutdown path (#661
 * Phase 2) and orphan reaper (#661 Phase 5) to leave Chrome alive across
 * MCP restart.
 *
 * `OPENCHROME_KILL_ON_EXIT` env var:
 *   - `auto` (default) — sync-kill at exit unless a non-expired token exists for this MCP pid.
 *   - `always`         — sync-kill regardless of tokens.
 *   - `never`          — never sync-kill (rely on user invoking oc_stop / next-startup reaper).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TOKEN_DIR = path.join(os.homedir(), '.openchrome', 'state');
const LOG_PREFIX = '[openchrome:resume-token]';

export type KillOnExitMode = 'auto' | 'always' | 'never';

export interface SessionResumeToken {
  /** MCP server PID that wrote the token. */
  mcpPid: number;
  /** Chrome PID that should survive across MCP restart. */
  chromePid: number;
  /** Chrome remote debugging port. */
  port: number;
  /** Optional profile-directory string (purely informational for the resume tool). */
  profileDir?: string;
  /** Epoch ms after which the token is invalid. */
  ttlEpochMs: number;
  /** Wall-clock at write, for logging. */
  createdAt: string;
}

const DEFAULT_TTL_MIN = 30;

export function tokenPathFor(mcpPid: number): string {
  return path.join(TOKEN_DIR, `session-resume-${mcpPid}.json`);
}

function ensureDir(): void {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error(`${LOG_PREFIX} Failed to create token dir ${TOKEN_DIR}:`, err);
    }
  }
}

export function ttlFromEnvMs(): number {
  const raw = process.env.OPENCHROME_SESSION_RESUME_TTL_MIN;
  if (!raw) return DEFAULT_TTL_MIN * 60_000;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MIN * 60_000;
  return parsed * 60_000;
}

export function writeResumeToken(opts: {
  chromePid: number;
  port: number;
  profileDir?: string;
  ttlMs?: number;
}): SessionResumeToken {
  ensureDir();
  const ttl = opts.ttlMs ?? ttlFromEnvMs();
  const token: SessionResumeToken = {
    mcpPid: process.pid,
    chromePid: opts.chromePid,
    port: opts.port,
    profileDir: opts.profileDir,
    ttlEpochMs: Date.now() + ttl,
    createdAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(token, null, 2);
  fs.writeFileSync(tokenPathFor(process.pid), payload, { encoding: 'utf8' });
  return token;
}

export function readResumeToken(mcpPid: number): SessionResumeToken | null {
  try {
    const raw = fs.readFileSync(tokenPathFor(mcpPid), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionResumeToken>;
    if (
      typeof parsed.mcpPid !== 'number' ||
      typeof parsed.chromePid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.ttlEpochMs !== 'number'
    ) {
      return null;
    }
    return parsed as SessionResumeToken;
  } catch {
    return null;
  }
}

export function deleteResumeToken(mcpPid: number): void {
  try {
    fs.unlinkSync(tokenPathFor(mcpPid));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to delete token for pid ${mcpPid}:`, err);
    }
  }
}

/**
 * Returns true if a non-expired session-resume token exists for the
 * current process. Synchronous (used from process.exit handlers).
 */
export function hasActiveResumeTokenForCurrentProcess(): boolean {
  const tok = readResumeToken(process.pid);
  if (!tok) return false;
  return tok.ttlEpochMs > Date.now();
}

export function listAllTokens(): SessionResumeToken[] {
  try {
    const entries = fs.readdirSync(TOKEN_DIR, { withFileTypes: true });
    const out: SessionResumeToken[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('session-resume-')) continue;
      const m = entry.name.match(/^session-resume-(\d+)\.json$/);
      if (!m) continue;
      const tok = readResumeToken(parseInt(m[1], 10));
      if (tok) out.push(tok);
    }
    return out;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.error(`${LOG_PREFIX} Failed to list tokens:`, err);
    return [];
  }
}

/** Reap expired tokens (called at startup). */
export function reapExpiredTokens(now: number = Date.now()): number {
  let reaped = 0;
  for (const tok of listAllTokens()) {
    if (tok.ttlEpochMs <= now) {
      deleteResumeToken(tok.mcpPid);
      reaped++;
    }
  }
  return reaped;
}

export function killOnExitMode(): KillOnExitMode {
  const raw = (process.env.OPENCHROME_KILL_ON_EXIT || 'auto').toLowerCase();
  if (raw === 'always' || raw === 'never') return raw;
  return 'auto';
}

/**
 * The per-exit decision: should the synchronous shutdown handler kill Chrome?
 */
export function shouldKillChromeOnExit(): boolean {
  const mode = killOnExitMode();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  // auto: kill unless an active token spares Chrome
  return !hasActiveResumeTokenForCurrentProcess();
}
