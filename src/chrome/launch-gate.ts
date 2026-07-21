/**
 * Launch Gate — deferred `autoLaunch` for `--launch-on-first-use`.
 *
 * Why this exists
 * ---------------
 * openchrome today has two extremes for Chrome lifecycle:
 *
 *   1. `autoLaunch=false` (default) · the server refuses to spawn Chrome
 *      even when a tool call needs it. The operator has to manually start
 *      Chrome with `--remote-debugging-port` before any request works.
 *   2. `autoLaunch=true` · Chrome is spawned aggressively — including at
 *      **server startup** (readiness probes, health endpoints, and any
 *      early `ensureChrome()` call), before any client tool call has
 *      arrived. This defeats a common ops pattern: run `openchrome serve`
 *      under a systemd unit or `pnpm dev` sidecar and let it sit idle
 *      until a real request appears.
 *
 * The gate is a middle position: `autoLaunch=true` **semantically**, but
 * physically Chrome only spawns after the *first tool call* has arrived.
 * Startup-time `ensureChrome()` calls that predate the first tool see
 * `autoLaunch=false` and fail loudly (or, in the readiness path, skip).
 * The moment MCP dispatches the first tool, the gate is armed and the
 * next `ensureChrome()` proceeds with the launch.
 *
 * Design
 * ------
 * - Module-level singleton with `arm()` / `disarm()` / `isArmed()` /
 *   `resetForTests()`. One process, one gate.
 * - `resolveEffectiveAutoLaunch(cfgAutoLaunch, opts)` — the sanctioned
 *   translator. Callers pass their configured `autoLaunch` and, when the
 *   caller opted into the gate, this returns `false` until the gate is
 *   armed and `cfgAutoLaunch` afterwards.
 * - `onFirstUse(fn)` — optional subscriber for observability (metrics,
 *   startup timing). Fires exactly once, on the first successful `arm()`.
 *
 * Wiring notes
 * ------------
 * The gate is intentionally decoupled from the CLI. A caller opts in per
 * `CDPClient` via `CDPClientOptions.launchOnFirstUse`, or globally via
 * `OPENCHROME_LAUNCH_ON_FIRST_USE=1`. The MCP tool-dispatch layer arms
 * the gate before invoking any tool; the health/readiness path does not.
 *
 * Origin credit
 * -------------
 * The "lazy launch on first tool" idiom is the same pattern many MCP
 * servers use to avoid warming heavyweight processes for idle registries
 * (see e.g. chrome-devtools-mcp's attach-on-demand recipe). This module
 * is a clean-room implementation.
 */

export interface LaunchGateOptions {
  /** When true, the caller opts into the deferred-launch behaviour. */
  launchOnFirstUse?: boolean;
}

let _armed = false;
let _armedAt = 0;
const _listeners: Array<() => void> = [];

/**
 * Arm the gate. Subsequent `resolveEffectiveAutoLaunch()` calls that
 * were previously being coerced to `false` will now return the caller's
 * configured `autoLaunch`. Fires the first-use listeners exactly once.
 *
 * Idempotent: repeated calls after the first are no-ops.
 */
export function arm(): void {
  if (_armed) return;
  _armed = true;
  _armedAt = Date.now();
  const snapshot = _listeners.slice();
  _listeners.length = 0;
  for (const fn of snapshot) {
    try {
      fn();
    } catch (err) {
      // Listener errors must not corrupt the gate state.
      console.error('[LaunchGate] first-use listener threw:', err);
    }
  }
}

/**
 * Disarm the gate. Intended for shutdown paths that want to prevent
 * further launches (e.g. graceful stop). New `ensureChrome()` calls
 * after this point behave as `autoLaunch=false` under the gate again.
 */
export function disarm(): void {
  _armed = false;
  _armedAt = 0;
}

/** Read the gate state. */
export function isArmed(): boolean {
  return _armed;
}

/** Timestamp of the arming event (0 if disarmed). */
export function armedAt(): number {
  return _armedAt;
}

/**
 * Subscribe to the first-use event. If the gate is already armed the
 * listener fires synchronously. Otherwise it fires exactly once on the
 * next `arm()` call.
 */
export function onFirstUse(fn: () => void): void {
  if (_armed) {
    try {
      fn();
    } catch (err) {
      console.error('[LaunchGate] first-use listener threw:', err);
    }
    return;
  }
  _listeners.push(fn);
}

/**
 * Read the env opt-in. Kept as a function so tests can stub the env per
 * call. Truthy values: `1`, `true`, `yes`, `on` (case-insensitive).
 */
export function envLaunchOnFirstUse(): boolean {
  const raw = process.env.OPENCHROME_LAUNCH_ON_FIRST_USE;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Sanctioned translator. Callers should never gate on `isArmed()`
 * directly — they should route their `autoLaunch` choice through this
 * function so the opt-in check and env override live in one place.
 *
 * Behaviour matrix (opt-in on):
 *   gate armed   → returns `cfgAutoLaunch` (pass-through)
 *   gate disarmed → returns `false` (defer launch)
 *
 * Behaviour matrix (opt-in off):
 *   any state → returns `cfgAutoLaunch` (pass-through)
 */
export function resolveEffectiveAutoLaunch(
  cfgAutoLaunch: boolean,
  opts: LaunchGateOptions = {},
): boolean {
  const optedIn = opts.launchOnFirstUse === true || envLaunchOnFirstUse();
  if (!optedIn) return cfgAutoLaunch;
  return _armed ? cfgAutoLaunch : false;
}

/** Test-only reset. */
export function resetLaunchGateForTests(): void {
  _armed = false;
  _armedAt = 0;
  _listeners.length = 0;
}
