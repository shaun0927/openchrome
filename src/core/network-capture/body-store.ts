/**
 * On-disk body store for full-mode network capture.
 *
 * Layout:
 *   ~/.openchrome/network-bodies/<sessionId>/<requestId>
 *
 * Bodies up to INLINE_BODY_THRESHOLD_BYTES are inlined in the entry as base64;
 * larger bodies (still within `maxBodyBytes`) are written to disk so that
 * memory pressure stays bounded.
 *
 * Lifecycle:
 *   • write(): atomic write of one body file. Returns absolute path.
 *   • cleanupSession(): rm -rf the session dir. Called on `stop` unless
 *     `keepBodies:true` is passed.
 *   • cleanupAllStaleSessions(): purge the entire root. Called from
 *     `pid-manager` at openchrome startup to recover from crashes.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const LOG_PREFIX = '[NetworkCapture:BodyStore]';

/** Absolute path to the network-capture body store root. */
export function getBodyStoreRoot(): string {
  return path.join(os.homedir(), '.openchrome', 'network-bodies');
}

/** Absolute path to a single session's body directory. */
export function getSessionBodyDir(sessionId: string): string {
  return path.join(getBodyStoreRoot(), sanitizeSegment(sessionId));
}

/** Absolute path to a single request's body file. */
export function getRequestBodyPath(sessionId: string, requestId: string): string {
  return path.join(getSessionBodyDir(sessionId), sanitizeSegment(requestId));
}

/**
 * Sanitize a path segment so a malformed sessionId/requestId cannot escape the
 * body store root. Replaces anything that isn't [A-Za-z0-9._-] with `_`.
 */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || '_';
}

/** Ensure the session body directory exists. */
export async function ensureSessionDir(sessionId: string): Promise<string> {
  const dir = getSessionBodyDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a body buffer to disk. Uses a temp-rename pattern so partial writes
 * are never visible to readers.
 */
export async function writeBody(
  sessionId: string,
  requestId: string,
  data: Buffer,
): Promise<string> {
  await ensureSessionDir(sessionId);
  const finalPath = getRequestBodyPath(sessionId, requestId);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmpPath, data, { flag: 'w' });
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  return finalPath;
}

/** Remove a single session's body directory (best-effort). */
export async function cleanupSession(sessionId: string): Promise<void> {
  const dir = getSessionBodyDir(sessionId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`${LOG_PREFIX} Failed to remove ${dir}:`, err);
    }
  }
}

/**
 * Purge every session subdirectory under the body-store root.
 *
 * Called from `pid-manager` at openchrome startup so that bodies left behind
 * by a SIGKILL'd process are reclaimed. Synchronous because the startup
 * lifecycle hook in pid-manager is synchronous.
 */
export function cleanupAllStaleSessionsSync(): number {
  const root = getBodyStoreRoot();
  let removed = 0;
  if (!fs.existsSync(root)) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to list ${root}:`, err);
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to remove ${target}:`, err);
    }
  }
  if (removed > 0) {
    console.error(`${LOG_PREFIX} Cleaned ${removed} stale session director${removed === 1 ? 'y' : 'ies'} under ${root}`);
  }
  return removed;
}
