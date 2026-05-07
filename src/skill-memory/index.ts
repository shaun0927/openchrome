/**
 * Verified Skill Memory subsystem barrel (#712).
 *
 * Extractor (#713) ships in PR-20; recall (#714) + curator (#715) ride
 * follow-up commits. The extractor is end-to-end testable today —
 * subsequent PRs slot in without changing the public surface here.
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
  isRecallEnabled,
  recallFromDisk,
} from './recall';
export type {
  SkillRecallEntry,
  SkillRecallOptions,
  SkillRecallPayload,
} from './recall';

export { CuratorLock, defaultCuratorRootDir } from './curator-lock';
export type { CuratorLockOptions } from './curator-lock';

export { runCurator } from './curator';
export type {
  CuratorAction,
  CuratorActionKind,
  CuratorOptions,
  CuratorReport,
  SkillRunStats,
  SkillStatsResolver,
} from './curator';

export {
  clusterSkills,
  jaccard,
  runPass2Merge,
  tokenize,
} from './curator-pass2';
export type {
  ClusterCandidate,
  MergeRequest,
  MergeRequester,
  MergeResult,
  MergeResultOk,
  MergeResultSkip,
  Pass2Outcome,
  RunPass2Options,
} from './curator-pass2';

export { STOP_WORDS } from './stop-words';

export {
  buildMergePrompt,
  createLlmMergeRequester,
  createLlmMergeRequesterFromRawText,
} from './llm-merge';
export type {
  CreateLlmMergeRequesterOptions,
  RawTextProvider,
} from './llm-merge';
