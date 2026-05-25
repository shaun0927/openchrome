/**
 * Tier: pilot
 *
 * Modules under src/pilot/** are opt-in via the `--pilot` CLI flag. The pilot
 * tier relaxes two principles from the portability-harness contract
 * (docs/roadmap/portability-harness-contract.md):
 *   P1 (relaxed): may run scheduled background work (e.g., skill curator)
 *                 only when the operator explicitly enables it.
 *   P4 (relaxed): may encode workflow policy (retry, escalation, irreversible
 *                 action confirmation).
 *
 * Pilot tier still satisfies **strictly**:
 *   P2 — server boots with `--pilot` unset and behaves bit-identically to 1.10.4.
 *   P3 — no outbound LLM API egress, no mandatory third-party credentials.
 *        Server-side LLM-driven decisions remain out of scope for the entire repo.
 *   P5 — native dependency discipline applies to both tiers.
 *
 * Pilot modules MAY import from src/core/** (enforced unidirectionally by
 * the dependency-cruiser rule "core-must-not-import-pilot").
 *
 * Submodules will be added under src/pilot/{executor,runtime,handoff,voting,
 * curator}/ as the 1.11 cleanup PRs land.
 */

// Phase 3 (issue #790): contract runtime is the first pilot subdir to land.
// Re-export as a namespace so `bootstrapPilot()` (in src/harness/flags.ts)
// can resolve it without hard-coupling the harness to the runtime entry.
// Keep this as a namespace export so adding sibling subdirs later does not
// reorder the public surface and break consumer destructuring.
export * as runtime from './runtime/index.js';

// Phase 3 (issue #793): pilot-tier handoff token + manager.
export * as handoff from './handoff/index.js';

// Phase 4 (issue #759): voter-agnostic multi-model voting framework.
// Gated by isPerceptionVotingEnabled() inside orchestrator.runVote().
// LLM-backed voter HTTP wrappers ship in openchrome-perception-voters (#775).
export * as voting from './voting/index.js';

// Phase 4 (issue #713): verified skill extractor — deterministic transform,
// no LLM calls. Gate call sites on `isSkillCuratorEnabled()` from
// `src/harness/flags.ts` before invoking any export from this namespace.
export * as curator from './curator/index.js';

// Phase 4 (issue #889): dynamic skill→tool synthesis. Gate call sites on
// `isDynamicSkillsEnabled()` from `src/harness/flags.ts` before invoking.
export * as dynamicSkills from './dynamic-skills/index.js';

// Phase 5 (issue #874): user-supplied proxy lifecycle binding. Pilot-tier
// MCP tool that lets the host declare origin→upstream rules without
// openchrome ever contacting the upstream proxy. Gate call sites on
// `isProxyHookEnabled()` from `src/harness/flags.ts` before invoking any
// export from this namespace.
export * as proxy from './proxy/index.js';
// Phase 4 (issue #820, blocks #717): pilot-tier skill graph executor.
// Pure `decide()` function — no I/O, no side effects. Gate call sites on
// `isStateGraphEnabled()` from `src/harness/flags.ts` before invoking.
export * as skill from './skill/index.js';

// Issue #837: pilot credential vault.
export * as credentials from './credentials/store.js';

import {
  isAutoMemoryEnabled,
  isAutoSkillifyEnabled,
  isContractRuntimeEnabled,
  isSkillCuratorEnabled,
  isStateGraphEnabled,
} from '../harness/flags.js';
import { registerAutoMemory, type AutoMemoryHandle } from './auto-memory/index.js';
import {
  createSidecarStatsResolver,
  defaultSkillRootDir,
  registerAutoExtractor,
  startCuratorRunner,
} from './curator/index.js';
import type { AutoExtractorHandle, CuratorRunner } from './curator/index.js';

/**
 * Handle returned by `bootstrap()`. Callers (notably tests) use
 * `stop()` to release the auto-extractor subscription and shut down
 * the curator runner timer. Production code rarely needs this — the
 * curator timer is `.unref()`-ed and the extractor subscription is
 * harmless after process exit — but keeping a handle makes the
 * lifecycle observable.
 */
export interface PilotBootstrapHandle {
  stop(): void;
}

/**
 * Pilot-side bootstrap. Invoked exactly once from
 * `src/harness/flags.ts:bootstrapPilot()` after `isPilotEnabled()`
 * returns true. Each side-effect is independently flag-gated so an
 * operator can keep, say, the skill curator running while opting out
 * of auto-skillify.
 *
 * Activation matrix (every condition AND-ed):
 *   - Auto-extractor: `OPENCHROME_AUTO_SKILLIFY` (opt-in) AND
 *     `contract_runtime` (default-on) AND `state_graph` (default-on).
 *   - Curator runner: `OPENCHROME_SKILL_CURATOR` (default-on inside
 *     pilot). Currently runs with `noopStatsResolver`; a follow-up
 *     PR wires the audit-log-backed resolver.
 *
 * Failures during each registration are caught and routed to stderr;
 * the runtime, MCP tool surface, and other pilot families are
 * unaffected.
 */
export function bootstrap(): PilotBootstrapHandle {
  const extractorHandles: AutoExtractorHandle[] = [];
  const curatorHandles: CuratorRunner[] = [];
  const memoryHandles: AutoMemoryHandle[] = [];

  if (isAutoSkillifyEnabled() && isContractRuntimeEnabled() && isStateGraphEnabled()) {
    try {
      extractorHandles.push(registerAutoExtractor({ rootDir: defaultSkillRootDir() }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pilot] auto-skillify register failed: ${message}\n`);
    }
  }

  if (isAutoMemoryEnabled() && isContractRuntimeEnabled()) {
    try {
      memoryHandles.push(registerAutoMemory());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pilot] auto-memory register failed: ${message}\n`);
    }
  }

  if (isSkillCuratorEnabled()) {
    try {
      curatorHandles.push(
        startCuratorRunner({
          rootDir: defaultSkillRootDir(),
          // Sidecar-backed resolver — successes and failures live in
          // the same per-skill `.json` rolling log, so prune's fail-
          // rate sub-pass observes real numbers without depending on
          // the audit-log family being enabled.
          statsResolver: createSidecarStatsResolver(),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pilot] curator runner start failed: ${message}\n`);
    }
  }

  return {
    stop(): void {
      for (const h of extractorHandles) {
        try { h.unregister(); } catch { /* */ }
      }
      for (const h of curatorHandles) {
        try { h.stop(); } catch { /* */ }
      }
      for (const h of memoryHandles) {
        try { h.unregister(); } catch { /* */ }
      }
      extractorHandles.length = 0;
      curatorHandles.length = 0;
      memoryHandles.length = 0;
    },
  };
}
