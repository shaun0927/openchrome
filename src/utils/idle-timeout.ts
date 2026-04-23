/**
 * Idle-timeout watcher — opt-in self-termination for idle stdio instances.
 *
 * Part of issue #649 Part B. When installed, polls on a `setTimeout` chain;
 * on each tick, if `idleState.isIdle(windowMs) && sessionCountFn() === 0`,
 * logs a single diagnostic line and calls `exitFn(0)`. The caller wires
 * `exitFn` to `enhancedShutdown('idle-timeout')` so the reentrancy guard
 * deduplicates with other internal exit triggers (PPID watcher, signals).
 *
 * Design notes:
 *  - Default OFF. Installed only when the `serve` command receives
 *    `--idle-timeout=<duration>` or `OPENCHROME_IDLE_TIMEOUT_MS=<n>`.
 *  - Tick interval is `min(windowMs/4, 60_000)`, capped so tiny windows
 *    (e.g. `--idle-timeout=3s` in tests) still fire within one second of
 *    the deadline, and large windows (e.g. `30m`) never exceed one check
 *    per minute.
 *  - Uses a `setTimeout` chain with `.unref()` so the timer never blocks
 *    normal shutdown and never keeps the process alive on its own.
 *  - `stop()` is idempotent and synchronous — callers invoke it from
 *    `enhancedShutdown` before any awaits so the timer cannot fire mid-
 *    shutdown.
 */

import { IdleState } from './idle-state';

/** Units accepted by `parseDuration` (see also issue #649 §3.2). */
const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

export interface IdleTimeoutOptions {
  /** Idle window in ms — when isIdle(windowMs) is true AND no sessions, exit. */
  windowMs: number;
  /** Source of the "is the server idle?" signal (shared with Part A monitors). */
  idleState: IdleState;
  /** Live session count at tick time. Exit only when this returns 0. */
  sessionCountFn: () => number;
  /** Exit function — production wires this to enhancedShutdown('idle-timeout'). */
  exitFn: (code: number) => void;
  /** Logger — defaults to console.error to stay off the stdio JSON-RPC channel. */
  logger?: (msg: string) => void;
  /**
   * Injected setTimeout / clearTimeout for unit tests. Production callers
   * should not pass these — Node's globals are the default.
   */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface IdleTimeoutHandle {
  /**
   * Cancel the watcher. Safe to call more than once; after the first call,
   * no further `exitFn` invocations are possible (the `stopped` flag is the
   * single source of truth, not just `clearTimeout`, because a callback
   * already on the macrotask queue when stop() runs would otherwise still
   * fire — see parent-watcher.ts for the same race note).
   */
  stop: () => void;
}

/**
 * Install the idle-timeout watcher. Caller owns lifecycle — must call
 * `handle.stop()` from the graceful shutdown path.
 */
export function installIdleTimeout(opts: IdleTimeoutOptions): IdleTimeoutHandle {
  const {
    windowMs,
    idleState,
    sessionCountFn,
    exitFn,
    logger = (msg: string) => console.error(msg),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = opts;

  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`[idle-timeout] windowMs must be a positive finite number, got ${windowMs}`);
  }

  // Tick at most every 60 s and at least every windowMs/4. Tiny windows
  // (3 s) thus fire ~every 750 ms; large windows (30 m) cap at 1 min.
  const tickMs = Math.min(windowMs / 4, 60_000);

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = (): void => {
    if (stopped) return;
    try {
      if (idleState.isIdle(windowMs) && sessionCountFn() === 0) {
        stopped = true;
        logger(`[openchrome] idle for ${formatDuration(windowMs)}, exiting`);
        try {
          exitFn(0);
        } catch (err) {
          // exitFn is the caller's shutdown path — surface failures but do
          // not re-throw from a timer callback.
          logger(`[openchrome] idle-timeout exit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    } catch (err) {
      logger(`[openchrome] idle-timeout tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Schedule next tick — setTimeout chain so each tick reads the current
    // idle state and session count fresh, and so .unref() applies per-tick.
    scheduleNext();
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeoutFn(tick, tickMs);
    if (timer && typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref();
    }
  };

  scheduleNext();

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
  };
}

/**
 * Parse a duration string like `30m`, `90s`, `2h`, `500ms` into milliseconds.
 * Throws on invalid input — in particular, bare numbers (e.g. `30`) are
 * rejected because interpreting them as milliseconds silently would kill
 * healthy instances immediately. Issue #649 §3.2 / acceptance criterion 12.
 */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new Error(`[idle-timeout] duration must be a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  // Regex: one or more digits, optional fractional part, then a required
  // unit suffix from DURATION_UNITS. Order (ms before m) is critical.
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `[idle-timeout] invalid duration "${input}" — expected <number>(ms|s|m|h), e.g. 30m, 90s, 500ms. Bare numbers without a unit suffix are rejected.`,
    );
  }
  const value = parseFloat(match[1]);
  const unit = match[2];
  const multiplier = DURATION_UNITS[unit];
  if (!multiplier) {
    // Unreachable given the regex, but keeps TypeScript happy and fails
    // loudly if the units map and the regex ever drift.
    throw new Error(`[idle-timeout] unknown unit "${unit}" in duration "${input}"`);
  }
  const ms = value * multiplier;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`[idle-timeout] duration "${input}" must resolve to a positive finite ms value`);
  }
  return ms;
}

/**
 * Format an ms value into the shortest unit that expresses it exactly, for
 * the diagnostic log line. 3_000 → "3s", 30 * 60_000 → "30m", 500 → "500ms".
 */
export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0 && ms >= 60_000) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0 && ms >= 1_000) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
