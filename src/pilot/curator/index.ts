/**
 * Pilot curator barrel (#712 epic, Phase 4).
 *
 * The extractor turns successful, contract-verified runs into reusable
 * SKILL.md candidates. The recall layer ranks stored skills for
 * LLM-facing payloads. Curator passes (Pass 1 prune, Pass 3 promote)
 * run as a background timer and keep the skill tree healthy.
 *
 * All exports are deterministic transforms (no LLM calls). LLM-augmented
 * skill merge is out of scope per portability-harness P3/P4 and is
 * tracked in a separate package (#776).
 *
 * Call sites that integrate with the contract runtime MUST gate on
 * `isSkillCuratorEnabled()` from `src/harness/flags.ts` before
 * invoking any export from this module.
 */

export {
  computeSkillId,
  defaultSkillRootDir,
  listSkillsForDomain,
  recordSuccessfulRun,
} from './extractor';
export type {
  ExtractionInputs,
  ExtractionResult,
  ExtractorOptions,
} from './extractor';

export {
  FrontmatterError,
  parseSkillMd,
  stringifySkillMd,
  validateFrontmatter,
} from './skill-md';

export {
  SKILL_RUN_LOG_MAX,
  SKILL_SCHEMA_VERSION,
} from './types';
export type {
  SkillAuthor,
  SkillFile,
  SkillFrontmatter,
  SkillRecord,
  SkillSidecar,
  SkillStatus,
} from './types';

// Curator Pass 1: prune (demote + archive)
export { runPrune } from './prune';
export type {
  PruneAction,
  PruneActionKind,
  PruneOptions,
  PruneReport,
  SkillRunStats,
  SkillStatsResolver,
} from './prune';

// Curator Pass 3: promote / recall ranking recompute
export { runPromote } from './promote';
export type { PromoteOptions, PromoteReport } from './promote';

// PID lock
export { CuratorLock, defaultCuratorLockDir } from './lock';
export type { CuratorLockOptions } from './lock';

// Background runner
export { startCuratorRunner } from './runner';
export type { CuratorRunner, CuratorRunnerOptions } from './runner';

// Auto-extractor — subscribes to `contractRuntimeEvents.transaction:settled`
// and feeds successful runs into `recordSuccessfulRun`. Gated by
// `OPENCHROME_AUTO_SKILLIFY` at the bootstrap call site.
export { registerAutoExtractor } from './auto-extractor';
export type { AutoExtractorHandle, AutoExtractorOptions } from './auto-extractor';

// Failure-side sidecar logger — used by the auto-extractor for the
// `postcondition_violation` verdict so the curator's prune sub-pass
// observes real fail rates instead of an all-healthy noop.
export { recordFailedRun } from './failed-run';
export type { FailedRunInputs, FailedRunResult } from './failed-run';

// Sidecar-backed `SkillStatsResolver` for `startCuratorRunner`.
// Replaces the historical `noopStatsResolver` so prune actually
// activates when fail-rates cross the threshold.
export { createSidecarStatsResolver } from './sidecar-stats';
export type { SidecarStatsResolverOptions } from './sidecar-stats';

// Auto-recall over the curator's SKILL.md tree. Surfaces promoted
// skills back into the LLM's context (typically via
// `oc_task_run_start`). Gated on `OPENCHROME_AUTO_RECALL=1` in
// addition to the pilot + skill-curator family flags.
export { hostnameForRecall, recallCuratorSkills } from './auto-recall';
export type {
  RecallCuratorSkillsInput,
  RecalledCuratorSkill,
  RecalledCuratorSkillsPayload,
} from './auto-recall';

// Recall ranking (read-only over SkillMemoryStore)
export {
  clusterSkills,
  jaccard,
  runMerge,
  tokenize,
} from './merge';
export type {
  ClusterCandidate,
  MergeAction,
  MergeActionKind,
  MergeOutcome,
  RunMergeOptions,
} from './merge';

export { STOP_WORDS } from './stop-words';

export {
  SkillRecallStore,
  buildRecallPayload,
  rankSkillsForRecall,
} from './recall';
export type {
  RankSkillsInput,
  RankSkillsOptions,
  SkillRecallPayload,
  SkillRecallResult,
} from './recall';
