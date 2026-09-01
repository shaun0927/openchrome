/**
 * Tier: pilot
 *
 * Modules under src/pilot/** are opt-in via the `--pilot` CLI flag. The pilot
 * tier may run scheduled background work and encode workflow policy only when
 * the operator explicitly enables it.
 *
 * Pilot tier still must keep the unflagged server bootable, avoid outbound LLM
 * API egress, and avoid mandatory third-party credentials.
 *
 * Pilot modules MAY import from src/core/** (enforced unidirectionally by
 * the dependency-cruiser rule "core-must-not-import-pilot").
 */

// Re-export as a namespace so `bootstrapPilot()` (in src/harness/flags.ts)
// can resolve it without hard-coupling the harness to the runtime entry.
// Keep this as a namespace export so adding sibling subdirs later does not
// reorder the public surface and break consumer destructuring.
export * as runtime from './runtime/index.js';

export * as handoff from './handoff/index.js';

// Gated by isPerceptionVotingEnabled() inside orchestrator.runVote().
// LLM-backed voter HTTP wrappers ship in openchrome-perception-voters (#775).
export * as voting from './voting/index.js';

export * as curator from './curator/index.js';

export * as dynamicSkills from './dynamic-skills/index.js';

export * as proxy from './proxy/index.js';

export * as skill from './skill/index.js';

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
 *     pilot). Uses the skill sidecar rolling log as its stats source
 *     so prune observes real success/failure rates without requiring
 *     the audit-log family.
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
