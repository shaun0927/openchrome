/**
 * Owner self-release (#1474).
 *
 * When the managed Chrome dies and cannot be brought back, the owner becomes a
 * half-zombie: its MCP process is alive but it can no longer provide a working
 * Chrome, yet it keeps holding the controller lock — deadlocking every other
 * parallel session, the exact outage reported in #1474.
 *
 * This wiring surrenders the controller lock and exits non-zero so the MCP host
 * respawns a fresh owner and the health-aware acquirer (another session, or our
 * own respawn) can take over. It is the proactive complement to the reactive
 * takeover in acquireControllerLockWithHealthCheck(): the dying owner releases
 * instead of waiting to be evicted.
 *
 * Trigger correctness: we do NOT key off `watchdog-exhausted`, which the
 * ChromeProcessWatchdog emits after N *successful* relaunches (Chrome is up at
 * that point) — exiting there would tear down a freshly-recovered browser and
 * drop active work. Instead we count consecutive `relaunch-failed` events
 * (reset by any `chrome-relaunched`) and, only once the failures cross a
 * threshold, confirm with a live CDP probe. The process exits only when Chrome
 * is genuinely unreachable, never while it is serving requests.
 */

import type { EventEmitter } from 'events';

/**
 * Non-zero exit code meaning "owner gave up Chrome; respawn me". Distinct from
 * the config-error exit(2) so logs/hosts can tell the two apart.
 */
export const OWNER_SELF_RELEASE_EXIT_CODE = 70;

/** Default consecutive relaunch failures before we confirm-and-release. */
export const DEFAULT_RELEASE_FAILURE_THRESHOLD = 2;

export interface OwnerSelfReleaseDeps {
  /** Release the controller lock held by this owner (best-effort, idempotent). */
  releaseLock: () => void;
  /** Terminate the process so the MCP host respawns a fresh owner. */
  exit: (code: number) => void;
  /**
   * Confirm whether this owner's Chrome/CDP is actually reachable right now.
   * The hard safety gate: a true result aborts self-release so a recovered or
   * still-serving Chrome is never torn down.
   */
  probeChromeReachable: () => Promise<boolean>;
  /** Consecutive relaunch failures before confirming. Default 2. */
  failureThreshold?: number;
  /** Logger. Defaults to console.error (stdout carries MCP JSON-RPC). */
  log?: (message: string) => void;
}

/**
 * Subscribe to the watchdog's relaunch-lifecycle events and, when Chrome is
 * confirmed irrecoverable, release the controller lock and exit.
 *
 * - `chrome-relaunched` → recovery succeeded; reset the failure counter.
 * - `relaunch-failed`   → a recovery attempt threw; count it. Once the count
 *   reaches the threshold, probe CDP. Release + exit only if unreachable.
 *
 * `chrome-died` (normal, the watchdog will relaunch) and a single
 * `relaunch-failed` (transient) never surrender ownership, so a momentary
 * crash cannot flap the lock.
 */
export function wireOwnerSelfRelease(watchdog: EventEmitter, deps: OwnerSelfReleaseDeps): void {
  const log = deps.log ?? ((m: string) => console.error(m));
  const threshold = Math.max(1, deps.failureThreshold ?? DEFAULT_RELEASE_FAILURE_THRESHOLD);
  let consecutiveFailures = 0;
  let releasing = false;
  let recoveredDuringProbe = false;

  watchdog.on('chrome-relaunched', () => {
    consecutiveFailures = 0;
    // A relaunch that lands while a self-release probe is in flight must abort
    // that decision: the new Chrome may not have bound its debug port yet, so a
    // `false` probe result would be stale and could tear down a recovered
    // browser. Record it; the in-flight probe checks this flag after awaiting.
    if (releasing) recoveredDuringProbe = true;
  });

  watchdog.on('relaunch-failed', () => {
    if (releasing) return;
    consecutiveFailures += 1;
    if (consecutiveFailures < threshold) return;

    releasing = true;
    recoveredDuringProbe = false;
    void (async () => {
      let reachable: boolean;
      try {
        reachable = await deps.probeChromeReachable();
      } catch (err) {
        // Inconclusive probe — do not tear down on uncertainty. Step the
        // counter back one so at least one more failure is required before we
        // re-probe, avoiding a tight no-back-off retry when the probe keeps
        // timing out.
        log(
          `[SelfHealing] Chrome reachability probe errored during self-release; ` +
            `staying up: ${err instanceof Error ? err.message : String(err)}`,
        );
        consecutiveFailures = Math.max(0, threshold - 1);
        releasing = false;
        return;
      }

      // A successful relaunch landed while we were probing — abort: a stale
      // `false` here would tear down the freshly recovered browser.
      if (recoveredDuringProbe) {
        recoveredDuringProbe = false;
        consecutiveFailures = 0;
        releasing = false;
        return;
      }

      if (reachable) {
        // Chrome is actually serving despite the relaunch error — keep running.
        consecutiveFailures = 0;
        releasing = false;
        return;
      }

      log(
        `[SelfHealing] Chrome unrecoverable after ${consecutiveFailures} consecutive ` +
          `relaunch failures and a confirming CDP probe; releasing controller lock and ` +
          `exiting (code ${OWNER_SELF_RELEASE_EXIT_CODE}) so another session can take over (#1474).`,
      );
      try {
        deps.releaseLock();
      } catch (err) {
        log(
          `[SelfHealing] Controller lock release failed during self-release: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      deps.exit(OWNER_SELF_RELEASE_EXIT_CODE);
    })();
  });
}
