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

export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return TRUTHY.has(value.trim().toLowerCase());
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
 * Dynamic skill → MCP tool synthesis (issue #889, apify-mcp adoption C).
 *
 * Deviation from the other families above: this one defaults **off** even
 * when `--pilot` is set. Synthesizing tools is the most invasive pilot
 * capability to date — it mutates the MCP tool surface mid-session and
 * emits proactive `notifications/tools/list_changed` frames outside any
 * tool's request lifetime. Operators must opt in explicitly with
 * `OPENCHROME_DYNAMIC_SKILLS=1` per the portability-harness contract P2
 * (zero-impact-when-off) requirement.
 */
export const isDynamicSkillsEnabled = (): boolean =>
  isFamilyEnabledOptIn('OPENCHROME_DYNAMIC_SKILLS');

const ALL_FAMILIES: ReadonlyArray<readonly [string, () => boolean]> = [
  ['trace', isTraceEnabled],
  ['state_graph', isStateGraphEnabled],
  ['contract_runtime', isContractRuntimeEnabled],
  ['handoff_persist', isHandoffPersistEnabled],
  ['perception_voting', isPerceptionVotingEnabled],
  ['skill_curator', isSkillCuratorEnabled],
  ['dynamic_skills', isDynamicSkillsEnabled],
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
  // Dynamic import keeps the pilot tree out of the static dependency graph
  // until `--pilot` is explicitly enabled at runtime.
  const mod = await import('../pilot/index.js');
  return mod;
}

/**
 * Test helper. Clears the cached pilot decision so subsequent tests can
 * exercise the parser with a different `process.argv` or env state.
 */
export function resetFlagsCache(): void {
  cachedPilot = null;
}
