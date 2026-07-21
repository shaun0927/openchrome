/**
 * Runtime.enable audit + minimal-window policy for stealth targets.
 *
 * Honest scope
 * ------------
 * Sending `Runtime.enable` on a CDP session has renderer-observable side
 * effects: it materialises an execution context, starts firing
 * `Runtime.executionContextCreated` events, and — most importantly for
 * stealth — makes `console.debug` serialisation walk target objects, which
 * enterprise anti-bot vendors (Radware, Akamai Bot Manager, PerimeterX,
 * DataDome) probe for.
 *
 * **This module does NOT prevent that leak.** Both `console_capture` and
 * `validate_page` fundamentally require the Runtime domain to be enabled
 * to do their job (capture console events, catch exceptions). Client-side
 * event filtering after the fact is theatre — by the time we filter, the
 * renderer has already fired the events the vendor script sees.
 *
 * What this module DOES provide:
 *
 *   1. **Single choke point.** `ensureRuntimeEnabled` is the only sanctioned
 *      way to send `Runtime.enable` on a stealth-flagged target. Direct
 *      `session.send('Runtime.enable')` calls in stealth-touching tools are
 *      an audit finding.
 *
 *   2. **Refuse-by-default in stealth.** An operator must consciously pass
 *      `stealthMode: 'allow'` to accept the leak. The refusal error names
 *      the caller so leaks are traceable.
 *
 *   3. **Minimal-window contract.** Every `ensureRuntimeEnabled` must be
 *      paired with `disableRuntime(session)` when the caller no longer
 *      needs live events. Callers are audited on this: `getGuardStats()`
 *      exposes counters test/monitoring code uses to prove enable calls are
 *      matched by disables. See `tests/stealth/runtime-enable-guard.integration.test.ts`.
 *
 * What was removed vs. earlier drafts
 * -----------------------------------
 * A `'shield'` mode that installed a client-side `Runtime.consoleAPICalled`
 * filter used to live here. It was removed because it did not defend
 * against the renderer-side leak it claimed to defend against — it only
 * filtered payloads that had already reached the CDP client. Keeping it
 * around encouraged operators to opt into stealth-mode Runtime.enable
 * believing they were shielded, which is worse than refusing outright.
 *
 * Origin credit: the `Runtime.enable` deferral idiom is from patchright
 * (Apache-2.0). This module is a narrower, honest port — patchright's
 * upstream can defer/batch because Playwright abstracts enable per-frame;
 * openchrome's tool surface exposes `console_capture` as a persistent
 * capture, so the same deferral is not architecturally available. The
 * honest posture is: audit + refuse-by-default + minimal window.
 */

import type { CDPSession } from 'puppeteer-core';

export type StealthEnableMode =
  /** Refuse Runtime.enable in stealth mode; caller must opt in explicitly. */
  | 'refuse'
  /** Enable Runtime.enable and accept the renderer-side leak. */
  | 'allow';

export interface EnsureRuntimeEnabledOptions {
  /** Is the target flagged stealth (SessionManager.isStealthTarget)? */
  isStealthTarget: boolean;
  /** How to behave in stealth mode. Ignored when `isStealthTarget=false`. */
  stealthMode?: StealthEnableMode;
  /** Caller name for audit + error diagnostics. */
  callerId?: string;
}

export interface GuardStats {
  /** Total ensureRuntimeEnabled calls that resulted in Runtime.enable being sent. */
  enableCalls: number;
  /** Total disableRuntime calls that resulted in Runtime.disable being sent. */
  disableCalls: number;
  /** Total ensureRuntimeEnabled calls refused (throws RuntimeEnableRefusedError). */
  refusals: number;
  /** Per-caller enable counts, keyed by callerId. */
  byCaller: Record<string, { enables: number; disables: number; refusals: number }>;
}

export class RuntimeEnableRefusedError extends Error {
  readonly code = 'runtime_enable_refused';
  constructor(callerId: string) {
    super(
      `[stealth] Refused to send Runtime.enable on a stealth target ` +
        `(caller="${callerId}"). Runtime.enable has renderer-observable ` +
        `side effects that enterprise anti-bot vendors probe for; this ` +
        `module does not shield them. To accept the leak, pass ` +
        `stealthMode="allow" to ensureRuntimeEnabled().`,
    );
    this.name = 'RuntimeEnableRefusedError';
  }
}

const stats: GuardStats = {
  enableCalls: 0,
  disableCalls: 0,
  refusals: 0,
  byCaller: {},
};

function bumpCaller(callerId: string, key: 'enables' | 'disables' | 'refusals'): void {
  const slot = stats.byCaller[callerId] ?? { enables: 0, disables: 0, refusals: 0 };
  slot[key] += 1;
  stats.byCaller[callerId] = slot;
}

/**
 * The only sanctioned way to send `Runtime.enable`.
 *
 * Non-stealth targets: passthrough (unchanged behaviour).
 * Stealth targets:
 *   - `refuse` (default): throws RuntimeEnableRefusedError. No enable is sent.
 *   - `allow`: sends Runtime.enable and accepts the renderer-side leak.
 *
 * Idempotent per Chrome semantics — a second `Runtime.enable` is a no-op
 * inside the browser, but each call is still counted for audit purposes so
 * callers who enable-in-a-loop are visible.
 */
export async function ensureRuntimeEnabled(
  session: CDPSession,
  opts: EnsureRuntimeEnabledOptions,
): Promise<void> {
  const callerId = opts.callerId ?? 'unknown';
  const mode: StealthEnableMode = opts.isStealthTarget ? (opts.stealthMode ?? 'refuse') : 'allow';

  if (mode === 'refuse') {
    stats.refusals += 1;
    bumpCaller(callerId, 'refusals');
    throw new RuntimeEnableRefusedError(callerId);
  }

  await session.send('Runtime.enable');
  stats.enableCalls += 1;
  bumpCaller(callerId, 'enables');
}

/**
 * The paired disable. Callers MUST call this once they no longer need live
 * Runtime events, minimising the enable-window. Best-effort — a detached
 * or crashed session yields no error.
 */
export async function disableRuntime(
  session: CDPSession,
  opts: { callerId?: string } = {},
): Promise<void> {
  const callerId = opts.callerId ?? 'unknown';
  try {
    await session.send('Runtime.disable');
  } catch {
    // Session may be gone — swallow so callers can chain in cleanup paths.
    return;
  }
  stats.disableCalls += 1;
  bumpCaller(callerId, 'disables');
}

/** Snapshot audit counters. Read-only from the caller's perspective. */
export function getGuardStats(): GuardStats {
  return {
    enableCalls: stats.enableCalls,
    disableCalls: stats.disableCalls,
    refusals: stats.refusals,
    byCaller: JSON.parse(JSON.stringify(stats.byCaller)),
  };
}

/** For tests — reset audit counters. */
export function __resetGuardStatsForTest(): void {
  stats.enableCalls = 0;
  stats.disableCalls = 0;
  stats.refusals = 0;
  stats.byCaller = {};
}
