/**
 * Curator single-instance lock (#715 v2).
 *
 * The curator runs as a background task; multiple `oc serve`
 * processes on the same machine must not run it concurrently. Per
 * #715 v2 P0 fix the lock is a PID file at
 * `~/.openchrome/skills/.curator/lock`:
 *
 *   1. If absent → write own PID + start_ts. Acquired.
 *   2. If present → read PID. Probe with `process.kill(pid, 0)` — if
 *      the holder is dead, reclaim.
 *   3. Hard TTL: if mtime > 1h old, reclaim regardless of liveness
 *      (the holder may be hung).
 *   4. Atomicity: write via temp + rename so partial files cannot
 *      look like a valid lockfile.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOCK_TTL_MS = 60 * 60 * 1000;

export interface CuratorLockOptions {
  rootDir?: string;
  /** TTL for stale lock reclamation. Default 1 hour. */
  ttlMs?: number;
  /** Test hook: pid liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Test hook: clock for mtime comparisons. */
  now?: () => number;
}

export function defaultCuratorRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skills', '.curator');
}

interface LockData {
  pid: number;
  start_ts: number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the PID exists but we can't signal it ⇒ alive.
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Acquire / release semantics. The lock object is single-use:
 * acquire() → release() then discard. Re-using a released instance
 * throws.
 */
export class CuratorLock {
  private readonly target: string;
  private readonly ttlMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private acquired = false;
  private released = false;

  constructor(opts: CuratorLockOptions = {}) {
    const root = opts.rootDir ?? defaultCuratorRootDir();
    fs.mkdirSync(root, { recursive: true });
    this.target = path.join(root, 'lock');
    this.ttlMs = opts.ttlMs ?? LOCK_TTL_MS;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
    this.now = opts.now ?? Date.now;
  }

  /** Attempt to acquire. Returns true on success, false otherwise. */
  acquire(): boolean {
    if (this.released) {
      throw new Error('CuratorLock: cannot reuse a released instance');
    }
    if (this.acquired) return true;
    if (this.tryWrite()) {
      this.acquired = true;
      return true;
    }
    // Lock exists — decide whether to reclaim.
    if (this.shouldReclaim()) {
      if (!this.reclaimStaleLock()) return false;
      const verify = this.read();
      if (!verify || verify.pid !== process.pid) return false;
      this.acquired = true;
      return true;
    }
    return false;
  }

  /** Release a previously-acquired lock. Idempotent. */
  release(): void {
    if (!this.acquired || this.released) return;
    this.released = true;
    this.acquired = false;
    try {
      const onDisk = this.read();
      // Only remove if it's still ours — protects against the race
      // where another reclaimer overwrote between our acquire and
      // release.
      if (onDisk && onDisk.pid === process.pid) {
        fs.unlinkSync(this.target);
      }
    } catch {
      // best-effort
    }
  }

  /** Inspect whoever currently holds (or stale-holds) the lock. */
  readHolder(): LockData | null {
    return this.read();
  }

  private read(): LockData | null {
    try {
      const txt = fs.readFileSync(this.target, 'utf8');
      const parsed = JSON.parse(txt) as Partial<LockData>;
      if (typeof parsed.pid === 'number' && typeof parsed.start_ts === 'number') {
        return { pid: parsed.pid, start_ts: parsed.start_ts };
      }
      return null;
    } catch {
      return null;
    }
  }

  private tryWrite(): boolean {
    try {
      // Open with `wx` flag — fails if the file already exists.
      const tmp = this.target + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, start_ts: this.now() }), {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        fs.linkSync(tmp, this.target);
        fs.unlinkSync(tmp);
        return true;
      } catch (e) {
        // Either link race or pre-existing target — drop temp + report.
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  private reclaimStaleLock(): boolean {
    const tmp = this.target + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, start_ts: this.now() }), {
        flag: 'wx',
        mode: 0o600,
      });
      if (!this.shouldReclaim()) return false;
      try {
        fs.unlinkSync(this.target);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') return false;
      }
      try {
        fs.linkSync(tmp, this.target);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  private shouldReclaim(): boolean {
    const holder = this.read();
    // Malformed lockfile → reclaim.
    if (!holder) return true;
    // Stale via TTL: file mtime > ttlMs old.
    try {
      const stat = fs.statSync(this.target);
      const ageMs = this.now() - stat.mtimeMs;
      if (ageMs > this.ttlMs) return true;
    } catch {
      return true;
    }
    // Holder dead.
    if (!this.isAlive(holder.pid)) return true;
    return false;
  }
}
