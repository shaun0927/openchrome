/**
 * Pilot Contract Runtime — barrel export.
 *
 * This is the bootstrap target dynamically imported by
 * `src/harness/flags.ts:bootstrapPilot()` via `src/pilot/index.ts`.
 *
 * Import-safety guarantee: this module must NOT throw on load even if
 * other pilot subdirectories (executor, handoff, voting, curator) are
 * missing. We only re-export from `./runtime.js`, `./types.js`, and
 * `./before-irreversible.js` so the surface stays self-contained.
 */

export {
  defaultAuditEmitter,
  LogAuditEntryEmitter,
  runWithContract,
} from './runtime.js';

export {
  defaultBeforeIrreversibleHook,
  getBeforeIrreversibleHook,
  registerBeforeIrreversibleHook,
  resetBeforeIrreversibleHookForTests,
} from './before-irreversible.js';

export {
  canonicalJson,
  DEFAULT_CACHE_TTL_MS,
  IdempotencyCache,
} from './idempotency.js';

export type { IdempotencyCacheOptions } from './idempotency.js';

export type {
  AuditEmitter,
  Contract,
  ContractRuntimeArgs,
  SkillFn,
  TransactionRecord,
  Verdict,
} from './types.js';

export type {
  BeforeIrreversibleDecision,
  BeforeIrreversibleHook,
  BeforeIrreversibleHookInput,
} from './before-irreversible.js';

export { contractRuntimeEvents } from './events.js';
export type {
  ContractRuntimeEventMap,
  TypedContractRuntimeEmitter,
} from './events.js';
