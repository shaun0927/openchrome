/**
 * Curator single-instance PID lock (Phase 4, #763).
 *
 * The curator runs as a background task; multiple `oc serve` processes on
 * the same machine must not run it concurrently against the same domain
 * root. Lock lives at `~/.openchrome/skills/.curator/lock`:
 *
 *   1. If absent → write own PID + start_ts. Acquired.
 *   2. If present → read PID. Probe with `process.kill(pid, 0)` — if
 *      the holder is dead, reclaim.
 *   3. Hard TTL: if mtime > 1 h old, reclaim regardless of liveness
 *      (the holder may be hung).
 *   4. Atomicity: write via temp + rename so partial files cannot look
 *      like a valid lockfile.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LOCK_TTL_MS = 60 * 60 * 1_000; // 1 hour

export interface CuratorLockOptions {
  rootDir?: string;
  /** TTL for stale lock reclamation. Default 1 hour. */
  ttlMs?: number;
  /** Test hook: pid liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Test hook: clock for mtime comparisons. */
  now?: () => number;
}

interface LockData {
  pid: number;
  start_ts: number;
}

export function defaultCuratorLockDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skills', '.curator');
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM → process exists but we lack permission to signal it → alive.
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Acquire / release semantics. The lock object is single-use:
 * acquire() → release() then discard. Re-using a released instance throws.
 */
export class CuratorLock {
  private readonly target: string;
  private readonly ttlMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private acquired = false;
  private released = false;

  constructor(opts: CuratorLockOptions = {}) {
    const root = opts.rootDir ?? defaultCuratorLockDir();
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
    // Lock file exists — decide whether to reclaim.
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
      // Only remove if it's still ours — another reclaimer may have
      // already taken over between our acquire and release.
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

  /**
   * Attempt an exclusive-create write via temp + link.
   * Fails fast if the target already exists.
   */
  private tryWrite(): boolean {
    const tmp = this.target + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, start_ts: this.now() }), {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        fs.linkSync(tmp, this.target);
        fs.unlinkSync(tmp);
        return true;
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return false;
      }
    } catch {
      return false;
    }
  }

  /** Overwrite stale lock with our PID via temp + unlink + link. */
  private reclaimStaleLock(): boolean {
    const tmp = this.target + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, start_ts: this.now() }), {
        flag: 'wx',
        mode: 0o600,
      });
      // Re-check staleness inside the critical section.
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
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  private shouldReclaim(): boolean {
    const holder = this.read();
    // Malformed or missing lockfile → reclaim.
    if (!holder) return true;
    // Stale via TTL: mtime > ttlMs ago.
    try {
      const stat = fs.statSync(this.target);
      if (this.now() - stat.mtimeMs > this.ttlMs) return true;
    } catch {
      return true;
    }
    // Holder dead.
    if (!this.isAlive(holder.pid)) return true;
    return false;
  }
}
