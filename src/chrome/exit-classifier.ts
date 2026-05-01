/**
 * Chrome exit classifier (#660).
 *
 * Distinguishes user-initiated close from a crash so the watchdog can stop
 * silently re-launching Chrome that the user just told the OS to close.
 *
 * Inputs are the Node `exit` event fields plus how long Chrome was alive
 * before the exit fired:
 *   - code   — process exit code, or `null` if killed by a signal
 *   - signal — POSIX signal name, or `null` if exited normally
 *   - uptimeMs — wall time from spawn to exit
 *   - intentionalStop — set by the launcher when oc_stop / shutdown ran
 *
 * Anti-flap: Chrome cold-start typically takes 1-3 s. A "clean" exit within
 * a few seconds overwhelmingly indicates a misconfigured launch (bad
 * --user-data-dir, missing binary) rather than a deliberate user action.
 * The threshold defaults to 5 s and is configurable via
 * OPENCHROME_ANTIFLAP_SECONDS.
 */

export type ExitClassification = 'intentional' | 'clean' | 'crash';

export interface ClassifyExitInput {
  /** Process exit code (number) or null if killed by a signal. */
  code: number | null;
  /** Signal name (e.g. 'SIGTERM') or null. */
  signal: NodeJS.Signals | null;
  /** Milliseconds Chrome was alive before exit. */
  uptimeMs: number;
  /** True if openchrome itself initiated the stop (oc_stop or MCP shutdown). */
  intentionalStop: boolean;
}

/**
 * Read the anti-flap threshold (in milliseconds) from
 * OPENCHROME_ANTIFLAP_SECONDS, with a 5-second default.
 *
 * Invalid / non-positive values fall back to the default. Callers can pass
 * an override for tests.
 */
export function antiFlapMs(envValue: string | undefined = process.env.OPENCHROME_ANTIFLAP_SECONDS): number {
  if (envValue === undefined || envValue === '') return 5_000;
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5_000;
  return parsed * 1000;
}

/**
 * Read the watchdog quiesce duration (ms) from OPENCHROME_QUIESCE_MS.
 * Default is 60 s.
 */
export function quiesceMs(envValue: string | undefined = process.env.OPENCHROME_QUIESCE_MS): number {
  if (envValue === undefined || envValue === '') return 60_000;
  const parsed = parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60_000;
  return parsed;
}

/**
 * Classify a Chrome exit.
 *
 * Decision matrix (highest priority first):
 *   1. intentionalStop=true   → 'intentional'
 *   2. uptimeMs < anti-flap   → 'crash' (Chrome failed to start cleanly)
 *   3. code===0 OR signal===SIGTERM/SIGINT/null → 'clean' (user closed window)
 *   4. otherwise              → 'crash' (segfault, OOM, abort, …)
 */
export function classifyExit(
  input: ClassifyExitInput,
  opts: { antiFlapMs?: number } = {},
): ExitClassification {
  if (input.intentionalStop) return 'intentional';

  const flapMs = opts.antiFlapMs ?? antiFlapMs();
  if (input.uptimeMs >= 0 && input.uptimeMs < flapMs) return 'crash';

  if (input.code === 0) return 'clean';

  const cleanSignals: ReadonlyArray<NodeJS.Signals> = ['SIGTERM', 'SIGINT'];
  if (input.signal === null && (input.code === null || input.code === 0)) return 'clean';
  if (input.signal !== null && cleanSignals.includes(input.signal)) return 'clean';

  return 'crash';
}

/**
 * Should the watchdog rate-limit relaunches because Chrome has been
 * crashing repeatedly? Returns true after `threshold` crashes inside
 * `windowMs`.
 *
 * Pure function: caller provides the timestamps array.
 */
export function shouldRateLimitRelaunch(
  recentCrashTimestampsMs: ReadonlyArray<number>,
  now: number = Date.now(),
  windowMs: number = 60_000,
  threshold: number = 3,
): boolean {
  let count = 0;
  for (const t of recentCrashTimestampsMs) {
    if (now - t <= windowMs) count++;
  }
  return count >= threshold;
}
