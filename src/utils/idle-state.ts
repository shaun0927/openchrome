/**
 * Idle-state tracker — records when the server last saw MCP or CDP activity.
 *
 * Part of issue #649 Part A (idle-adaptive monitoring): each of the long-lived
 * monitors reads `isIdle(windowMs)` on every tick and picks its delay (active
 * vs relaxed rate) locally. `notifyActive()` is wired at every MCP request
 * handler entry and at every inbound CDP event, so the next tick observes
 * `isIdle === false` and reverts to active rates.
 *
 * Design notes:
 *  - Pure module with no timers, no side effects. All time comes from the
 *    injected `now()` function so tests are deterministic.
 *  - Semantics for a fresh instance: "never active" is treated as "always
 *    idle" → `isIdle(anyWindow) === true` until the first `notifyActive()`.
 *  - `isIdle(0)` returns `true` immediately after `notifyActive()` because
 *    `now - lastActive >= 0` is trivially true. This is the documented
 *    contract: passing `0` means "fire immediately", not "disable". Callers
 *    that want to disable the timer must omit the flag entirely.
 */

export interface IdleStateOptions {
  /** Time source, injected for testability. Defaults to `Date.now`. */
  now?: () => number;
}

export interface IdleState {
  /** Record that the server just saw activity (inbound RPC or CDP event). */
  notifyActive: () => void;
  /**
   * Returns true if at least `windowMs` have elapsed since the last
   * `notifyActive()` call. A fresh instance (never active) is considered idle
   * for any window.
   */
  isIdle: (windowMs: number) => boolean;
  /**
   * Timestamp of the most recent `notifyActive()` call, or `0` if none yet.
   * Exposed for observability / debugging — monitors should call `isIdle()`.
   */
  lastActiveAt: () => number;
}

export function createIdleState(opts: IdleStateOptions = {}): IdleState {
  const now = opts.now ?? Date.now;
  // `null` is the "never active" sentinel — distinct from the clock value 0,
  // which is a legitimate timestamp (fake-clock tests may pin `now()` at 0).
  let lastActive: number | null = null;

  return {
    notifyActive(): void {
      lastActive = now();
    },
    isIdle(windowMs: number): boolean {
      // "Never active" is always idle — a monitor tick sees this before any
      // RPC has come in, and should relax immediately.
      if (lastActive === null) return true;
      return now() - lastActive >= windowMs;
    },
    lastActiveAt(): number {
      return lastActive ?? 0;
    },
  };
}

// ─── Singleton accessor ──────────────────────────────────────────────────────
//
// The monitors and transports both need the same IdleState instance. A simple
// module-level singleton is used — matching the pattern already established by
// getMCPServer(), getCDPClient(), getSessionManager(), etc.

let globalIdleState: IdleState | null = null;

/**
 * Retrieve the shared IdleState singleton. Lazy-created on first call.
 *
 * Honors `OPENCHROME_IDLE_ADAPTIVE=0` at construction time: when disabled,
 * returns an IdleState whose `isIdle()` always reports `false`, so every
 * monitor keeps ticking at its active rate regardless of RPC traffic. This is
 * the single feature-flag kill switch for Part A.
 */
export function getIdleState(): IdleState {
  if (globalIdleState) return globalIdleState;

  if (process.env.OPENCHROME_IDLE_ADAPTIVE === '0') {
    // Feature flag off — synthesize an always-active state so every monitor
    // keeps its current cadence. notifyActive() is still callable (no-op)
    // so wiring at every MCP handler remains safe.
    globalIdleState = {
      notifyActive(): void { /* no-op */ },
      isIdle(): boolean { return false; },
      lastActiveAt(): number { return Date.now(); },
    };
    return globalIdleState;
  }

  globalIdleState = createIdleState();
  return globalIdleState;
}

/**
 * Reset the singleton — test-only. Allows test suites to start from a fresh
 * IdleState without polluting cross-test state.
 */
export function resetIdleStateForTests(): void {
  globalIdleState = null;
}

/**
 * The idle window used by all monitors (5 minutes per issue #649 §3.1).
 * Exported so monitors and tests share one source of truth.
 */
export const IDLE_WINDOW_MS = 5 * 60_000;
