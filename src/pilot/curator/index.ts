/**
 * Pilot curator barrel (#712 epic, Phase 4 — verified skill extractor
 * + recall ranking).
 *
 * The extractor turns successful, contract-verified runs into reusable
 * SKILL.md candidates. It is a deterministic transform (no LLM calls).
 * The recall layer ranks stored skills for LLM-facing payloads.
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
