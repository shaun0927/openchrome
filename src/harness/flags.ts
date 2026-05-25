/**
 * Harness feature-flag loader.
 *
 * Implements the activation policy from the portability-harness contract
 * (docs/roadmap/portability-harness-contract.md):
 *
 *   - `--pilot` CLI flag (or OPENCHROME_PILOT env) gates the pilot tier as a whole.
 *   - When the gate is closed, no module from `src/pilot/**` is loaded into the
 *     process; `bootstrapPilot()` returns null without invoking `import()`.
 *   - When the gate is open, six per-family sub-flags individually enable the
 *     specific pilot families. Each defaults to *active* inside pilot and can
 *     be overridden to false via its environment variable.
 *
 * This module lives in `src/core/` conceptually (it ships unflagged) but stays
 * at `src/harness/` so both core and pilot modules can import it without
 * tripping the `core-must-not-import-pilot` lint rule.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Core-tier feature flag (issue #844 family).
 *
 * Unlike pilot family flags (which require `--pilot` to be enabled), core
 * flags ship unflagged in `openchrome serve` and use the env var to allow
 * operators to opt out for byte-parity testing.
 *
 *   - `defaultOn=true`:  enabled unless the env var is explicitly falsy
 *                        (`0`, `false`, `no`, `off`).
 *   - `defaultOn=false`: disabled unless the env var is explicitly truthy
 *                        (`1`, `true`, `yes`, `on`).
 *
 * This helper is purely additive — it does not affect existing pilot helpers.
 * It is unaffected by `isPilotEnabled()`.
 *
 * Used by:
 *   - `OPENCHROME_NODE_REF` (default ON; backend-node uid contract, #844).
 */
export function isCoreFeatureEnabled(envVar: string, defaultOn: boolean): boolean {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === '') return defaultOn;
  const normalized = raw.trim().toLowerCase();
  if (defaultOn) {
    return !FALSY.has(normalized);
  }
  return TRUTHY.has(normalized);
}

function pilotFromArgv(argv: readonly string[] = process.argv): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pilot') return true;
    if (arg.startsWith('--pilot=')) return isTruthy(arg.slice('--pilot='.length));
  }
  return false;
}

let cachedPilot: boolean | null = null;

interface PilotBootstrapModule {
  bootstrap?: () => unknown;
}

interface PilotBootstrapHandle {
  stop(): void;
}

let pilotBootstrapModulePromise: Promise<unknown> | null = null;
let pilotBootstrapHandle: PilotBootstrapHandle | null = null;

function isPilotBootstrapHandle(value: unknown): value is PilotBootstrapHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { stop?: unknown }).stop === 'function'
  );
}

export function stopPilotBootstrap(): void {
  const handle = pilotBootstrapHandle;
  pilotBootstrapHandle = null;
  pilotBootstrapModulePromise = null;
  if (handle === null) return;
  try {
    handle.stop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[harness] pilot bootstrap cleanup failed: ${message}\n`);
  }
}

/**
 * Returns true iff the operator enabled the pilot tier — either by passing
 * `--pilot` on the command line or by setting OPENCHROME_PILOT to a truthy
 * value. The result is cached after the first call. Use `resetFlagsCache()`
 * in tests to clear the cache between scenarios.
 */
export function isPilotEnabled(): boolean {
  if (cachedPilot !== null) return cachedPilot;
  cachedPilot = pilotFromArgv() || isTruthy(process.env.OPENCHROME_PILOT);
  return cachedPilot;
}

/**
 * Per-family activation. Returns false unless `--pilot` is enabled. When the
 * pilot gate is open, the family defaults to active; an explicit falsy env
 * value (e.g., `OPENCHROME_TRACE=0`) turns it off.
 */
function isFamilyEnabled(envVar: string): boolean {
  if (!isPilotEnabled()) return false;
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === '') return true;
  return isTruthy(raw);
}

/**
 * Per-family activation that **defaults to off** even when `--pilot` is set.
 * Reserved for pilot capabilities that mutate the MCP tool surface or emit
 * proactive notifications outside the request/response lifetime. Operators
 * must opt in explicitly via the env var.
 */
function isFamilyEnabledOptIn(envVar: string): boolean {
  if (!isPilotEnabled()) return false;
  return isTruthy(process.env[envVar]);
}

export const isTraceEnabled = (): boolean => isFamilyEnabled('OPENCHROME_TRACE');
export const isStateGraphEnabled = (): boolean => isFamilyEnabled('OPENCHROME_STATE_GRAPH');
export const isContractRuntimeEnabled = (): boolean => isFamilyEnabled('OPENCHROME_CONTRACT_RUNTIME');
export const isHandoffPersistEnabled = (): boolean => isFamilyEnabled('OPENCHROME_HANDOFF_PERSIST');
export const isPerceptionVotingEnabled = (): boolean => isFamilyEnabled('OPENCHROME_PERCEPTION_VOTING');
export const isSkillCuratorEnabled = (): boolean => isFamilyEnabled('OPENCHROME_SKILL_CURATOR');

/**
 * Returns true iff OPENCHROME_AUTO_RECALL is set to a truthy value.
 * Core-tier flag — no pilot gate. No caching so tests can reset env freely.
 */
export function isAutoRecallEnabled(): boolean {
  return isTruthy(process.env.OPENCHROME_AUTO_RECALL);
}

/**
 * Dynamic skill → MCP tool synthesis (issue #889, apify-mcp adoption C).
 * Defaults off even when `--pilot` is set because it mutates the MCP tool
 * surface mid-session and emits proactive list_changed notifications.
 */
export const isDynamicSkillsEnabled = (): boolean =>
  isFamilyEnabledOptIn('OPENCHROME_DYNAMIC_SKILLS');

/**
 * Pilot-tier skill replay (#856). Off-by-default even when `--pilot` is on:
 * the operator must explicitly opt in via `OPENCHROME_SKILL_REPLAY=1`.
 */
export const isSkillReplayEnabled = (): boolean =>
  isFamilyEnabledOptIn('OPENCHROME_SKILL_REPLAY');

/**
 * Auto-skillify: subscribe the curator's auto-extractor to
 * `transaction:settled` and write SKILL.md candidates on every
 * successful contract verdict. Off-by-default even when `--pilot` is
 * set because writing to `~/.openchrome/skills/<domain>/` is a side-
 * effect outside the request/response lifetime — operators must opt
 * in explicitly via `OPENCHROME_AUTO_SKILLIFY=1`. See
 * `src/pilot/curator/auto-extractor.ts` for the activation chain.
 */
export const isAutoSkillifyEnabled = (): boolean =>
  isFamilyEnabledOptIn('OPENCHROME_AUTO_SKILLIFY');

/**
 * Auto-memory: subscribe to `transaction:settled` and accrete
 * per-domain selector confidence in the core `DomainMemory` store.
 * Off-by-default for the same reason as auto-skillify — disk
 * mutation outside the request/response lifetime. See
 * `src/pilot/auto-memory/index.ts` for the activation chain.
 */
export const isAutoMemoryEnabled = (): boolean =>
  isFamilyEnabledOptIn('OPENCHROME_AUTO_MEMORY');

/** Pilot-tier React DevTools hook inspection (#838). Defaults on inside --pilot. */
export const isReactPilotEnabled = (): boolean =>
  isFamilyEnabled('OPENCHROME_REACT_PILOT');

/**
 * Proxy hook family (issue #874). Explicit opt-in on top of --pilot.
 */
export function isProxyHookEnabled(): boolean {
  if (!isPilotEnabled()) return false;
  return isTruthy(process.env.OPENCHROME_PROXY_HOOK);
}


const ALL_FAMILIES: ReadonlyArray<readonly [string, () => boolean]> = [
  ['trace', isTraceEnabled],
  ['state_graph', isStateGraphEnabled],
  ['contract_runtime', isContractRuntimeEnabled],
  ['handoff_persist', isHandoffPersistEnabled],
  ['perception_voting', isPerceptionVotingEnabled],
  ['skill_curator', isSkillCuratorEnabled],
  ['dynamic_skills', isDynamicSkillsEnabled],
  ['skill_replay', isSkillReplayEnabled],
  ['react_pilot', isReactPilotEnabled],
  ['proxy_hook', isProxyHookEnabled],
  ['auto_skillify', isAutoSkillifyEnabled],
  ['auto_memory', isAutoMemoryEnabled],
];

/**
 * Returns the list of pilot families currently active, in declaration order.
 * Empty when the pilot gate is closed.
 */
export function activeFamilies(): string[] {
  return ALL_FAMILIES.filter(([, fn]) => fn()).map(([name]) => name);
}

/**
 * Writes a single line to stderr describing which tiers and families are
 * active. Per CLAUDE.md never use stdout — that carries the MCP JSON-RPC
 * payload and would corrupt the protocol.
 */
export function logActiveFlags(): void {
  if (!isPilotEnabled()) {
    process.stderr.write('[harness] core only (--pilot not set)\n');
    return;
  }
  const fams = activeFamilies();
  const list = fams.length > 0 ? fams.join(',') : 'no families active';
  process.stderr.write(`[harness] core+pilot enabled (${list})\n`);
}

/**
 * Lazily loads the pilot bootstrap module. Returns null when the pilot gate
 * is closed, in which case no code from `src/pilot/**` is loaded into the
 * process. Returns the resolved module otherwise.
 *
 * Callers wire pilot tools through this entry point so that
 * `tools/list` returns the 1.10.4 surface when `--pilot` is unset (per
 * principle P2 of the portability-harness contract).
 */
export async function bootstrapPilot(): Promise<unknown | null> {
  if (!isPilotEnabled()) return null;
  if (pilotBootstrapModulePromise !== null) return pilotBootstrapModulePromise;

  // Dynamic import keeps the pilot tree out of the static dependency graph
  // until `--pilot` is explicitly enabled at runtime.
  pilotBootstrapModulePromise = import('../pilot/index.js')
    .then((mod: PilotBootstrapModule) => {
      // Invoke the optional pilot-side bootstrap once so side-effecting
      // wiring (auto-skillify subscriber, curator runner) is idempotent
      // across repeated entry-point initialization in one process.
      if (pilotBootstrapHandle === null && typeof mod.bootstrap === 'function') {
        try {
          const handle = mod.bootstrap();
          if (isPilotBootstrapHandle(handle)) {
            pilotBootstrapHandle = handle;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[harness] pilot bootstrap failed: ${message}\n`);
        }
      }
      return mod;
    })
    .catch((err) => {
      pilotBootstrapModulePromise = null;
      throw err;
    });

  return pilotBootstrapModulePromise;
}

/**
 * Test helper. Clears the cached pilot decision so subsequent tests can
 * exercise the parser with a different `process.argv` or env state.
 */
export function resetFlagsCache(): void {
  stopPilotBootstrap();
  cachedPilot = null;
}
