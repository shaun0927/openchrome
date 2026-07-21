/**
 * Raw-CDP mode.
 *
 * Nodriver's core insight is that most "stealth" bugs come from CDP itself,
 * not from JavaScript. Every time a controller calls `Runtime.enable`,
 * `Page.enable`, `DOM.enable`, or attaches an isolated world, the target
 * gains signals a real browser session would never emit. The mitigation is
 * to only send the small set of CDP domains that are *strictly* required
 * for the requested action, and to omit the passive listeners entirely.
 *
 * This module encodes that policy as a small, injectable filter that a CDP
 * client can consult before dispatching a command:
 *
 *   const mode = createRawCdpMode({ level: 'strict' });
 *   if (!mode.allow('Runtime.enable', { source: 'auto-attach' })) return;
 *   await client.send('Runtime.enable');
 *
 * The default policy list is derived from the nodriver docs (see census
 * entry A5) but written from scratch. No code is copied from nodriver.
 *
 * Three levels:
 *   - `off`      — permit everything. Preserves current openchrome behaviour.
 *   - `lean`     — drop the notorious passive listeners
 *                  (`Runtime.consoleAPICalled`, `Log.entryAdded`, etc.) but
 *                  keep enables that the action layer requests explicitly.
 *   - `strict`   — additionally forbid the passive `*.enable` commands
 *                  unless the caller marks them `source: 'user-action'`.
 *
 * The filter never mutates the CDP transport itself; it only advises the
 * caller. This keeps the module a pure decision function that is trivial
 * to test.
 */

export type RawCdpLevel = 'off' | 'lean' | 'strict';

export type RawCdpSource =
  | 'auto-attach'
  | 'passive-listener'
  | 'action'
  | 'user-action'
  | 'diagnostic';

export interface RawCdpDecisionInput {
  source: RawCdpSource;
}

export interface RawCdpDecision {
  allowed: boolean;
  reason: string;
}

export interface RawCdpModeOptions {
  level: RawCdpLevel;
  /**
   * Extra methods to always block, regardless of level. Useful for turning
   * a domain off on specific hosts.
   */
  extraBlocklist?: readonly string[];
  /**
   * Methods that are explicitly permitted even under `strict`. Escape hatch
   * for stacks that genuinely need e.g. `Runtime.evaluate`.
   */
  allowlist?: readonly string[];
}

/**
 * The passive listeners that leak the most stealth signal in practice.
 * These fire without a corresponding request, so their presence in the
 * outgoing CDP stream is a fingerprint on its own.
 */
const PASSIVE_LEAK_METHODS = new Set<string>([
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Log.entryAdded',
  'Debugger.paused',
  'Debugger.scriptParsed',
  'Debugger.scriptFailedToParse',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
]);

/**
 * Domain enables that are safe when a real user action requests them, but
 * suspicious when emitted purely because the controller attached.
 */
const GUARDED_ENABLE_METHODS = new Set<string>([
  'Runtime.enable',
  'Page.enable',
  'Debugger.enable',
  'DOM.enable',
  'Network.enable',
  'Log.enable',
  'Inspector.enable',
]);

export interface RawCdpMode {
  readonly level: RawCdpLevel;
  allow(method: string, input?: RawCdpDecisionInput): boolean;
  explain(method: string, input?: RawCdpDecisionInput): RawCdpDecision;
}

export function createRawCdpMode(options: RawCdpModeOptions): RawCdpMode {
  const extras = new Set(options.extraBlocklist ?? []);
  const allowlist = new Set(options.allowlist ?? []);
  const level = options.level;

  const explain = (method: string, input?: RawCdpDecisionInput): RawCdpDecision => {
    if (allowlist.has(method)) {
      return { allowed: true, reason: 'allowlist' };
    }
    if (extras.has(method)) {
      return { allowed: false, reason: 'extra-blocklist' };
    }
    if (level === 'off') {
      return { allowed: true, reason: 'level=off' };
    }
    if (PASSIVE_LEAK_METHODS.has(method)) {
      return { allowed: false, reason: 'passive-leak' };
    }
    if (level === 'lean') {
      return { allowed: true, reason: 'level=lean' };
    }
    // strict
    if (GUARDED_ENABLE_METHODS.has(method)) {
      if (input?.source === 'user-action') {
        return { allowed: true, reason: 'strict:user-action' };
      }
      return { allowed: false, reason: 'strict:guarded-enable' };
    }
    return { allowed: true, reason: 'strict:default-allow' };
  };

  return {
    level,
    allow: (method, input) => explain(method, input).allowed,
    explain,
  };
}

/**
 * Small helper used by clients that want to log every blocked call
 * without imposing a logger dependency on the mode itself.
 */
export function withRawCdpAudit(
  mode: RawCdpMode,
  onBlock: (method: string, decision: RawCdpDecision) => void,
): RawCdpMode {
  return {
    level: mode.level,
    allow(method, input) {
      const decision = mode.explain(method, input);
      if (!decision.allowed) onBlock(method, decision);
      return decision.allowed;
    },
    explain: mode.explain,
  };
}

/**
 * Resolve the active raw-CDP level from (in precedence order):
 *   1. `OPENCHROME_RAW_CDP_LEVEL` env var (`off` | `lean` | `strict`)
 *   2. `globalConfig.stealth?.rawCdpLevel`
 *   3. `off` (preserves current openchrome behaviour)
 *
 * Kept as a small pure function so tests can inject any config shape without
 * importing the global config module.
 */
export function resolveRawCdpLevel(
  envValue: string | undefined,
  configValue: RawCdpLevel | undefined,
): RawCdpLevel {
  const normalize = (v: string | undefined): RawCdpLevel | undefined => {
    if (v === 'off' || v === 'lean' || v === 'strict') return v;
    return undefined;
  };
  return normalize(envValue) ?? configValue ?? 'off';
}

let cachedMode: RawCdpMode | null = null;
let cachedLevel: RawCdpLevel | null = null;

/**
 * Global accessor used by the CDP call sites. Reads env + global config on
 * every call but memoises the underlying policy object per-level so hot paths
 * stay allocation-free.
 */
export function getRawCdpMode(
  envValue: string | undefined,
  configValue: RawCdpLevel | undefined,
): RawCdpMode {
  const level = resolveRawCdpLevel(envValue, configValue);
  if (cachedMode && cachedLevel === level) return cachedMode;
  cachedMode = createRawCdpMode({ level });
  cachedLevel = level;
  return cachedMode;
}

/**
 * TEST-ONLY. Drops the memoised mode so subsequent `getRawCdpMode` calls
 * re-read env/config. Never called from production code paths.
 */
export function __resetRawCdpModeCacheForTests(): void {
  cachedMode = null;
  cachedLevel = null;
}

/**
 * Minimal shape of a CDP session that the guard needs — matches puppeteer's
 * `CDPSession.send` without pinning the whole type.
 */
export interface GuardedSession {
  send(method: string, params?: unknown): Promise<unknown>;
}

/**
 * Send a CDP command through the raw-CDP mode policy. When the mode blocks
 * the method, the call is skipped and a `blocked:<reason>` sentinel string is
 * returned instead of the CDP result. Callers that need the real result must
 * handle that sentinel (or use `source: 'user-action'` to bypass strict).
 *
 * This is the actual wiring seam — replacing `session.send('Runtime.enable')`
 * with `sendGuarded(session, 'Runtime.enable', undefined, 'auto-attach')`
 * means that under strict mode the domain is never enabled on the wire, which
 * is the fingerprint delta nodriver documents.
 */
export async function sendGuarded(
  session: GuardedSession,
  method: string,
  params: unknown,
  source: RawCdpSource,
  mode?: RawCdpMode,
): Promise<unknown> {
  // Lazy require to avoid pulling global config into this pure module at
  // load time (and to keep the module tree-shakeable when only the pure
  // policy is imported).
  const activeMode =
    mode ?? (require('./raw-cdp-runtime') as typeof import('./raw-cdp-runtime')).getActiveRawCdpMode();
  const decision = activeMode.explain(method, { source });
  if (!decision.allowed) {
    return `blocked:${decision.reason}`;
  }
  return session.send(method, params);
}
