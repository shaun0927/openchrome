/**
 * Parent process liveness watcher.
 *
 * Symmetric counterpart to spawnProcessGuardian (src/utils/process-guardian.ts):
 * spawnProcessGuardian kills Chrome when openchrome dies; installParentWatcher
 * kills openchrome when its launching MCP-client parent dies.
 *
 * Wired only in stdio transport mode — HTTP and "both" modes are intentionally
 * daemon-capable and must survive their launching shells.
 *
 * See https://github.com/shaun0927/openchrome/issues/644 for the leak this
 * complements the cooperative stdin-EOF defense in src/transports/stdio.ts.
 */

const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 60_000;

export interface ParentWatcherOptions {
  parentPid: number;
  intervalMs?: number;
  logger?: (msg: string) => void;
  // Injected for unit testing — production callers should not pass these.
  isAliveFn?: (pid: number) => boolean;
  exitFn?: (code: number) => void;
}

export interface ParentWatcherHandle {
  stop: () => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we cannot signal it (typical on Windows).
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function clampInterval(value: number | undefined): number {
  const raw = Number.isFinite(value) ? Number(value) : 2_000;
  if (raw < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
  if (raw > MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
  return raw;
}

/**
 * Install a polling watcher that exits this process when `parentPid` is no
 * longer alive. Returns a handle whose `stop()` cancels the watcher — call
 * this from the graceful shutdown path so it cannot fire mid-shutdown.
 *
 * Caller is responsible for deciding whether to install at all (transport
 * mode, env var opt-out, ppid > 1 check, etc.).
 */
export function installParentWatcher(opts: ParentWatcherOptions): ParentWatcherHandle {
  const intervalMs = clampInterval(opts.intervalMs);
  const isAlive = opts.isAliveFn ?? defaultIsAlive;
  const exit = opts.exitFn ?? ((code: number) => process.exit(code));
  const log = opts.logger ?? ((msg: string) => console.error(msg));

  const timer = setInterval(() => {
    if (isAlive(opts.parentPid)) return;
    log(`[openchrome] parent pid ${opts.parentPid} is gone, exiting`);
    clearInterval(timer);
    exit(0);
  }, intervalMs);

  // Never block a normal shutdown path waiting on the watcher.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
}
