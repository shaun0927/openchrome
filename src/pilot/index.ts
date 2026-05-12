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
