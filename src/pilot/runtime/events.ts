/**
 * Process-local event bus for the pilot contract runtime.
 *
 * `runWithContract` settles exactly one `TransactionRecord` per call.
 * Once that record is in the audit pipeline, subscribers that want to
 * derive secondary state (skill extraction, dashboards, etc.) listen
 * here rather than wrapping the audit emitter — keeping each consumer
 * decoupled from every other.
 *
 * Why an event bus and not a direct call:
 *   - The runtime's always-settles guarantee must not be at the mercy
 *     of consumer correctness. A listener that throws or rejects
 *     cannot rewrite the verdict; the bus + setImmediate dispatch
 *     pattern enforces that mechanically.
 *   - Consumers can come and go (e.g., the curator's auto-extractor
 *     turns on with `OPENCHROME_AUTO_SKILLIFY`) without changing the
 *     runtime's call graph.
 *
 * Pattern mirrors `src/pilot/dynamic-skills/events.ts` deliberately:
 *   - Typed surface over Node's built-in `EventEmitter`.
 *   - Process-singleton exported by value (esm/cjs referential
 *     equality preserved).
 *   - No third-party transport (portability-harness P3).
 */

import { EventEmitter } from 'node:events';

import type { TransactionRecord } from './types.js';

/**
 * Strict event map. The runtime emits `transaction:settled` exactly
 * once per `runWithContract` call, regardless of verdict, after the
 * record has already been pushed through the audit emitter. Listeners
 * receive the same `TransactionRecord` reference held by the audit
 * pipeline; they MUST treat it as read-only.
 */
export interface ContractRuntimeEventMap {
  'transaction:settled': [TransactionRecord];
}

export interface TypedContractRuntimeEmitter {
  emit<E extends keyof ContractRuntimeEventMap>(
    event: E,
    ...args: ContractRuntimeEventMap[E]
  ): boolean;
  on<E extends keyof ContractRuntimeEventMap>(
    event: E,
    listener: (...args: ContractRuntimeEventMap[E]) => void,
  ): TypedContractRuntimeEmitter;
  off<E extends keyof ContractRuntimeEventMap>(
    event: E,
    listener: (...args: ContractRuntimeEventMap[E]) => void,
  ): TypedContractRuntimeEmitter;
  removeAllListeners<E extends keyof ContractRuntimeEventMap>(
    event?: E,
  ): TypedContractRuntimeEmitter;
  listenerCount<E extends keyof ContractRuntimeEventMap>(event: E): number;
}

const emitter = new EventEmitter() as unknown as TypedContractRuntimeEmitter;

/**
 * Process-singleton runtime emitter. Exported by value so the
 * subscriber-side `registerAutoExtractor` and any test harness see
 * the same instance regardless of import path.
 */
export const contractRuntimeEvents: TypedContractRuntimeEmitter = emitter;
