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
  Contract,
  ContractRuntimeArgs,
  AuditEmitter,
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
