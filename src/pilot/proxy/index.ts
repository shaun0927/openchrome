/**
 * Pilot proxy barrel — issue #874 (browserbase adoption D).
 *
 * Re-exports the `oc_proxy_hook` tool and its supporting types. Import-safe:
 * this module re-exports siblings only, no work happens at load. The pilot
 * bootstrap (`src/pilot/index.ts`) may import this barrel unconditionally
 * without bringing eager side effects.
 *
 * Gating: callers MUST gate on `isProxyHookEnabled()` from
 * `src/harness/flags.ts` before invoking `registerOcProxyHookTool`. The flag
 * requires both `--pilot` AND `OPENCHROME_PROXY_HOOK=1` (per the issue's
 * r2 critic pass — extra opt-in to reduce blast radius within pilot).
 */

export {
  compileOriginGlob,
  decideProxyAuth,
  getProxyBindingsSnapshot,
  matchOrigin,
  parseUpstream,
  registerOcProxyHookTool,
  _resetProxyBindingsForTesting,
} from './hook';
export type {
  ParsedUpstream,
  ProxyAuthDecision,
  ProxyBindingReport,
  ProxyHookAction,
  ProxyHookOptions,
  ProxyHookResponse,
  ProxyRule,
} from './hook';
