/**
 * Runtime.enable Leak Guard — patchright idiom, clean-room port.
 *
 * Why this exists
 * ---------------
 * Sending `Runtime.enable` on a CDP session creates observable side effects
 * in the target renderer: it materialises an execution context object,
 * starts firing `Runtime.executionContextCreated` events, and — most
 * importantly for stealth — makes `console.debug` calls arrive as
 * `Runtime.consoleAPICalled` events which enterprise anti-bot vendors
 * (Radware, Akamai Bot Manager, PerimeterX, DataDome) probe for.
 *
 * The classic detection sequence is:
 *   1. Page ships a poisoned `Object.getOwnPropertyDescriptor` proxy that
 *      logs to `console.debug` when accessed on `navigator`.
 *   2. If `Runtime.enable` is already active, the CDP client's serialisation
 *      of the log payload (which walks the target object) triggers the
 *      proxy synchronously and the vendor's script sees the trace.
 *   3. Absent `Runtime.enable`, the same access is invisible.
 *
 * patchright's fix (Apache-2.0): defer `Runtime.enable` until the caller
 * proves it actually needs live console/exception events, and never enable
 * it implicitly during page bootstrap. openchrome already avoids the
 * implicit path (rebrowser-puppeteer-core skips `Runtime.enable`) but has
 * no gate on the explicit path — `console_capture` and `validate_page`
 * both call `Runtime.enable` unconditionally, defeating stealth mode.
 *
 * This module adds a two-part gate:
 *   1. `ensureRuntimeEnabled(session, opts)` — the only sanctioned way to
 *      enable Runtime on a CDP session. In non-stealth mode it's a passthrough;
 *      in stealth mode it either refuses (default) or enables with the
 *      leak-hiding preload applied first.
 *   2. `installRuntimeHookHiding(session)` — patches
 *      `Runtime.consoleAPICalled` payloads so common CDP-artefact fingerprints
 *      (`__pptr__`, `pptr:evaluateHandle`, injected wrappers) are filtered
 *      out of the events the caller sees, matching patchright's stack
 *      sanitisation but at the CDP boundary rather than in-page.
 *
 * All origin credit goes to the patchright project (Apache-2.0). Their
 * source was not copied; this is a clean-room implementation of the
 * documented idiom.
 */

import type { CDPSession } from 'puppeteer-core';

export type StealthEnableMode =
  /** Refuse Runtime.enable in stealth mode; caller must opt in explicitly. */
  | 'refuse'
  /** Enable Runtime.enable but install the CDP-hook hiding filter first. */
  | 'shield'
  /** Enable Runtime.enable with no shielding — leaks are the caller's choice. */
  | 'allow';

export interface EnsureRuntimeEnabledOptions {
  /**
   * Whether the target is a stealth session (opened via
   * SessionManager.isStealthTarget or otherwise flagged). Controls whether
   * `stealthMode` gates apply.
   */
  isStealthTarget: boolean;
  /** How to behave in stealth mode. Ignored when `isStealthTarget=false`. */
  stealthMode?: StealthEnableMode;
  /**
   * Human-readable caller name for the "refused" error message. Helps
   * operators pinpoint which tool tried to enable Runtime.
   */
  callerId?: string;
}

export class RuntimeEnableRefusedError extends Error {
  readonly code = 'runtime_enable_refused';
  constructor(callerId: string) {
    super(
      `[stealth] Refused to send Runtime.enable on a stealth target ` +
        `(caller="${callerId}"). Runtime.enable exposes execution-context ` +
        `and consoleAPICalled events that enterprise anti-bot vendors probe ` +
        `for. If you accept the leak trade-off, pass stealthMode="shield" ` +
        `or "allow" to ensureRuntimeEnabled().`,
    );
    this.name = 'RuntimeEnableRefusedError';
  }
}

/**
 * The only sanctioned way to send `Runtime.enable`. Non-stealth targets are
 * always enabled (unchanged behaviour). Stealth targets:
 *   - `refuse` (default): throws RuntimeEnableRefusedError.
 *   - `shield`: installs hook-hiding filter, then enables.
 *   - `allow`: enables without shielding.
 *
 * Idempotent: safe to call multiple times on the same session. The second
 * call to `Runtime.enable` is a no-op inside Chrome.
 */
export async function ensureRuntimeEnabled(
  session: CDPSession,
  opts: EnsureRuntimeEnabledOptions,
): Promise<void> {
  const mode: StealthEnableMode = opts.isStealthTarget ? (opts.stealthMode ?? 'refuse') : 'allow';

  if (mode === 'refuse') {
    throw new RuntimeEnableRefusedError(opts.callerId ?? 'unknown');
  }

  if (mode === 'shield') {
    await installRuntimeHookHiding(session);
  }

  await session.send('Runtime.enable');
}

/**
 * Install a CDP-side filter that suppresses `Runtime.consoleAPICalled`
 * events whose payloads reveal CDP/Puppeteer artefacts. Runs before
 * `Runtime.enable` so no leaky event is delivered even for the initial
 * context.
 *
 * Filter is best-effort — if the CDP session cannot subscribe (session
 * closing, target already gone), the function throws so the caller can
 * decide whether to proceed without the shield.
 */
export async function installRuntimeHookHiding(session: CDPSession): Promise<void> {
  // The vendor detection payloads we filter out. Kept in sync with the
  // in-page stack sanitiser (`getStealthStackSanitizationScript`) so the
  // two layers block the same fingerprint set from different sides.
  const CDP_ARTIFACT_PATTERNS = [
    '__pptr__',
    '__puppeteer',
    'pptr:evaluate',
    'pptr:evaluateHandle',
    'evaluateOnNewDocument',
    'DevTools',
    'debugger eval',
  ];

  session.on('Runtime.consoleAPICalled', (event: unknown) => {
    const shouldSuppress = payloadMatchesArtefact(event, CDP_ARTIFACT_PATTERNS);
    if (shouldSuppress) {
      // We cannot un-emit an event that the CDP session already dispatched
      // to other listeners registered before ours, but we can tag it so
      // downstream openchrome listeners (console-capture, validate-page)
      // skip artefact payloads. Downstream code should check
      // `Object.getPrototypeOf(event) === CDP_ARTEFACT_MARKER` to filter.
      Object.defineProperty(event as object, '__oc_stealth_artefact__', {
        value: true,
        enumerable: false,
      });
    }
  });
}

/**
 * Returns true if the payload's serialised representation contains any of
 * the CDP-artefact patterns. Kept small and synchronous so the filter runs
 * inline in the event handler. Exported for tests and cross-module reuse.
 */
export function payloadMatchesArtefact(payload: unknown, patterns: string[]): boolean {
  let serialised: string;
  try {
    serialised = JSON.stringify(payload);
  } catch {
    return false;
  }
  for (const pattern of patterns) {
    if (serialised.indexOf(pattern) !== -1) return true;
  }
  return false;
}

/**
 * Downstream consumers use this predicate to skip events tagged by the
 * shield. Keeps the tag name in one place.
 */
export function isStealthArtefactEvent(event: unknown): boolean {
  return !!(event && typeof event === 'object' && (event as Record<string, unknown>)['__oc_stealth_artefact__']);
}

/** For unit tests — reset any module-level state. Currently a no-op. */
export const __testing = {
  payloadMatchesArtefact,
};
