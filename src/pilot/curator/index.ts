/**
 * Pilot curator barrel (#712 epic, Phase 4 — extractor + curator passes).
 *
 * The extractor turns successful, contract-verified runs into reusable
 * SKILL.md candidates. The curator (Pass 1 prune + Pass 3 promote) runs
 * as a background timer and keeps the skill tree healthy.
 *
 * All exports are deterministic transforms (no LLM calls).
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
