/**
 * Outcome Contracts subsystem barrel — assertion DSL types, validator,
 * evaluator. Runtime (PR-11), idempotency / cancellation (PR-12), and
 * evidence bundling (PR-13) build on these primitives.
 */

export type {
  Assertion,
  AssertionKind,
  CompositeAssertionKind,
  DomCountOp,
  Evidence,
  NetworkSinceMode,
  PrimitiveAssertionKind,
} from './types';
export {
  COMPOSITE_ASSERTION_KINDS,
  PRIMITIVE_ASSERTION_KINDS,
} from './types';

export { validateAssertion, type ValidationError } from './validator';
export { evaluate, type AssertionContext } from './evaluator';

export {
  runWithContract,
  defaultAuditEmitter,
  LogAuditEntryEmitter,
} from './runtime';
export type {
  BeforeIrreversibleActionHook,
  Contract,
  ContractRuntimeArgs,
  AuditEmitter,
  IrreversibleActionDecision,
  SkillFn,
  TransactionRecord,
  Verdict,
} from './runtime';

export {
  SqliteIdempotencyStore,
  canonicalJson,
  computeIdempotencyKey,
  defaultIdempotencyRootDir,
} from './idempotency';
export type { IdempotencyStore, IdempotencyStoreOptions } from './idempotency';

export {
  writeEvidenceBundle,
  readEvidenceBundle,
  readTransactionResource,
  parseTransactionUri,
  defaultBundleRootDir,
  TRANSACTION_URI_PREFIX,
} from './evidence';
export type {
  BundleManifest,
  BundleWriteResult,
  EvidenceBundleInputs,
  EvidenceBundleOptions,
  EvidenceTraceEvent,
} from './evidence';

export {
  hammingDistance,
  hammingDistanceHex,
  phashFromGrayscale,
  phashFromRgba,
} from './phash';
export type { PhashResult } from './phash';

export {
  ScreenshotClassRegistry,
  defaultScreenshotClassRootDir,
  normalizeClassId,
  recommendThreshold,
  HASH_BITS,
} from './screenshot-classes';
export type {
  ScreenshotClassRecord,
  ScreenshotClassRegistryOptions,
  ScreenshotClassThreshold,
} from './screenshot-classes';

export {
  HANDOFF_TOKEN_HEX_LENGTH,
  HandoffManager,
  bannerTagName,
  buildBannerScript,
  generateHandoffToken,
  verifyHandoffToken,
} from './handoff';
export type {
  BannerSpec,
  CreateHandoffArgs,
  HandoffEscalationReason,
  HandoffManagerOptions,
  HandoffRecord,
  HandoffStatus,
  ResumeResult,
} from './handoff';
