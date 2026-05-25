/**
 * Curator background runner (Phase 4, #763).
 *
 * Starts a `setInterval` timer that fires Pass 1 (prune) + Pass 3
 * (promote) on a configurable cadence. The interval is `.unref()`-ed so
 * it never prevents the Node process from exiting naturally.
 *
 * A `CuratorLock` is acquired before each cycle and released after.
 * If the lock cannot be acquired (another `oc serve` already holds it),
 * the cycle is silently skipped.
 *
 * Call sites MUST gate on `isSkillCuratorEnabled()` before calling
 * `startCuratorRunner()`.
 *
 * Example:
 *
 *   import { isSkillCuratorEnabled } from '../../harness/flags.js';
 *   import { startCuratorRunner } from './runner.js';
 *
 *   if (isSkillCuratorEnabled()) {
 *     startCuratorRunner({ rootDir: defaultSkillRootDir() });
 *   }
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { CuratorLock, defaultCuratorLockDir, type CuratorLockOptions } from './lock.js';
import { runPrune, type SkillStatsResolver } from './prune.js';
import { runPromote } from './promote.js';

/** Default interval: 30 minutes. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1_000;

export interface CuratorRunnerOptions {
  /** Root of the skill file tree (e.g. `~/.openchrome/skills`). */
  rootDir?: string;
  /** Override the PID lock directory. Default: `~/.openchrome/skills/.curator`. */
  lockDir?: string;
  /** Interval between curator cycles in ms. Default: 30 min. */
  intervalMs?: number;
  /**
   * Stats resolver for Pass 1 prune. When omitted, a no-op resolver is
   * used — all skills are treated as healthy (0 failures in window,
   * touched recently). Callers should supply a real resolver that reads
   * the active skill statistics source.
   */
  statsResolver?: SkillStatsResolver;
  /** Test hook: clock. */
  now?: () => number;
  /**
   * Test hook: called after each completed cycle with any errors that
   * occurred. Useful for surfacing cycle failures in tests without
   * coupling to stderr.
   */
  onCycleComplete?: (errors: string[]) => void;
  /**
   * Test hook: extra options forwarded to `CuratorLock` constructor.
   * Use to inject `isAlive` or `ttlMs` in unit tests without spawning
   * real competing processes.
   */
  lockOptions?: Pick<CuratorLockOptions, 'isAlive' | 'ttlMs'>;
}

export interface CuratorRunner {
  /** Stop the background timer. Idempotent. */
  stop(): void;
}

function defaultRootDir(): string {
  return path.join(os.homedir(), '.openchrome', 'skills');
}

/**
 * No-op stats resolver: treats every skill as healthy so Pass 1 does
 * nothing when no stats source is wired.
 */
const noopStatsResolver: SkillStatsResolver = (_record) => ({
  successesInWindow: 1,
  failuresInWindow: 0,
  lastRunAt: Date.now(),
  demotesInDoubleDemoteWindow: 0,
});

/**
 * Start the curator background runner. Returns a handle to stop it.
 *
 * The first cycle runs after `intervalMs`; it does not fire immediately
 * so the hosting process can finish startup before the curator begins
 * touching the skill tree.
 */
export function startCuratorRunner(opts: CuratorRunnerOptions = {}): CuratorRunner {
  const rootDir = opts.rootDir ?? defaultRootDir();
  const lockDir = opts.lockDir ?? defaultCuratorLockDir();
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const statsResolver = opts.statsResolver ?? noopStatsResolver;
  const now = opts.now ?? Date.now;

  async function runCycle(): Promise<void> {
    const lock = new CuratorLock({ rootDir: lockDir, now, ...opts.lockOptions });
    if (!lock.acquire()) {
      // Another process holds the lock — skip this cycle.
      opts.onCycleComplete?.([]);
      return;
    }
    const cycleErrors: string[] = [];
    try {
      // Pass 1: prune (deterministic, sync).
      const pruneReport = runPrune(statsResolver, { rootDir, now });
      cycleErrors.push(...pruneReport.errors);

      // Pass 3: promote / recall ranking recompute (async store writes).
      const promoteReport = await runPromote({ rootDir, now });
      cycleErrors.push(...promoteReport.errors);
    } catch (e) {
      cycleErrors.push(`curator cycle error: ${(e as Error).message}`);
    } finally {
      lock.release();
    }

    if (cycleErrors.length > 0) {
      for (const err of cycleErrors) {
        console.error(`[curator] ${err}`);
      }
    }

    opts.onCycleComplete?.(cycleErrors);
  }

  const timer = setInterval(() => {
    runCycle().catch((e: Error) => {
      console.error(`[curator] unhandled cycle error: ${e.message}`);
    });
  }, intervalMs);

  // Do not prevent the process from exiting when this is the only
  // remaining pending work.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
