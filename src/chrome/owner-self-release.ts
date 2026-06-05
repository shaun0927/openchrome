/**
 * Owner self-release (#1474).
 *
 * When the Chrome process watchdog exhausts its relaunch budget, the owner has
 * become a half-zombie: its MCP process is alive but it can no longer bring
 * Chrome back. Holding the controller lock in that state deadlocks every other
 * parallel session, which is the exact outage reported in #1474.
 *
 * This wiring surrenders the controller lock and exits non-zero so the MCP host
 * respawns a fresh owner and the health-aware acquirer (another session, or our
 * own respawn) can take over. It is the proactive complement to the reactive
 * health-aware takeover added to acquireControllerLockWithHealthCheck(): the
 * dying owner releases instead of waiting to be evicted.
 */

import type { EventEmitter } from 'events';

/**
 * Non-zero exit code meaning "owner gave up Chrome; respawn me". Distinct from
 * the config-error exit(2) so logs/hosts can tell the two apart.
 */
export const OWNER_SELF_RELEASE_EXIT_CODE = 70;

export interface OwnerSelfReleaseDeps {
  /** Release the controller lock held by this owner (best-effort, idempotent). */
  releaseLock: () => void;
  /** Terminate the process so the MCP host respawns a fresh owner. */
  exit: (code: number) => void;
  /** Logger. Defaults to console.error (stdout carries MCP JSON-RPC). */
  log?: (message: string) => void;
}

/**
 * Subscribe to the watchdog's terminal `watchdog-exhausted` event and, when it
 * fires, release the controller lock and exit.
 *
 * Only `watchdog-exhausted` triggers release. `chrome-died` is the normal
 * recoverable case (the watchdog relaunches) and a single `relaunch-failed` is
 * transient (the watchdog retries); surrendering ownership on either would flap
 * the lock on every Chrome crash. We only let go once the watchdog itself has
 * given up and stopped.
 */
export function wireOwnerSelfRelease(watchdog: EventEmitter, deps: OwnerSelfReleaseDeps): void {
  const log = deps.log ?? ((m: string) => console.error(m));
  watchdog.on('watchdog-exhausted', (event?: { count?: number }) => {
    const cycles = event?.count ?? '?';
    log(
      `[SelfHealing] Chrome unrecoverable after ${cycles} relaunch cycles; ` +
        `releasing controller lock and exiting (code ${OWNER_SELF_RELEASE_EXIT_CODE}) ` +
        `so another session can take over (#1474).`,
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
  });
}
