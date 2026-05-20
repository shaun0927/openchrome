/**
 * Auto-memory — bridges `transaction:settled` to the core
 * `memory` tool's `DomainMemory` store, accreting per-domain
 * selector confidence without any caller-side wiring.
 *
 * Activation chain:
 *   - `--pilot` (or `OPENCHROME_PILOT=1`) — pilot tier gate.
 *   - `OPENCHROME_CONTRACT_RUNTIME` (default-on inside pilot) — the
 *     runtime that emits `transaction:settled`.
 *   - `OPENCHROME_AUTO_MEMORY=1` — explicit opt-in. Off by default
 *     even under `--pilot` because writing to the on-disk
 *     `DomainMemory` store is a side-effect outside the
 *     request/response lifetime (matches the `isFamilyEnabledOptIn`
 *     precedent for `OPENCHROME_AUTO_SKILLIFY`).
 *
 * Per-record semantics:
 *   - On `verdict === 'success'`: every selector appearing in the
 *     contract's `pre_evidence` or `post_evidence` details tree is
 *     recorded with key `selector:<selector>` and value
 *     `<contract_id>`. The DomainMemory store handles dedup and
 *     bumps the entry's confidence each time we re-record.
 *   - On `verdict === 'postcondition_violation'`: every selector
 *     touched gets a `validate(id, false)` call so confidence
 *     decays for selectors that participate in failures. We only
 *     decay entries we previously recorded — never silently mark
 *     externally-recorded keys as failing.
 *
 * Always-settles preservation:
 *   - The subscriber runs inside `setImmediate` so the runtime's
 *     synchronous emit path returns before any disk I/O begins.
 *   - All exceptions are caught and surfaced on stderr (never
 *     stdout — that carries MCP JSON-RPC).
 */

import {
  contractRuntimeEvents,
  type TypedContractRuntimeEmitter,
} from '../runtime/events.js';
import type { TransactionRecord } from '../runtime/types.js';
import { getDomainMemory, type DomainMemory } from '../../memory/domain-memory.js';

export interface AutoMemoryHandle {
  unregister(): void;
}

export interface AutoMemoryOptions {
  /** Test hook: override the event bus singleton. */
  bus?: TypedContractRuntimeEmitter;
  /** Test hook: override the DomainMemory implementation. */
  memory?: Pick<DomainMemory, 'record' | 'validate' | 'query'>;
  /**
   * Test hook: invoked after a settle-event listener completes
   * (success or failure dispatch). Tests use this to await the
   * fire-and-forget `setImmediate` dispatch without polling sleeps.
   */
  onProcessed?: (event:
    | { ok: true; recordedSelectors: number }
    | { ok: true; decayedSelectors: number }
    | { ok: false; error: Error }
  ) => void;
}

const SELECTOR_KEY_PREFIX = 'selector:';
const MAX_SELECTOR_BYTES = 512;

export function registerAutoMemory(opts: AutoMemoryOptions = {}): AutoMemoryHandle {
  const bus = opts.bus ?? contractRuntimeEvents;
  const memory = opts.memory ?? getDomainMemory();

  const listener = (record: TransactionRecord): void => {
    if (record.verdict !== 'success' && record.verdict !== 'postcondition_violation') {
      return;
    }
    const domain = record.contract_domain;
    if (typeof domain !== 'string' || domain.length === 0) return;

    setImmediate(() => {
      try {
        const selectors = collectSelectors(record);
        if (selectors.size === 0) {
          // Nothing to do — common path when the contract used URL /
          // network assertions instead of DOM ones.
          opts.onProcessed?.({ ok: true, recordedSelectors: 0 });
          return;
        }
        if (record.verdict === 'success') {
          for (const selector of selectors) {
            memory.record(domain, SELECTOR_KEY_PREFIX + selector, record.contract_id);
          }
          opts.onProcessed?.({ ok: true, recordedSelectors: selectors.size });
        } else {
          // postcondition_violation — decay confidence on prior
          // recordings that share the (domain, selector) key.
          let decayed = 0;
          for (const selector of selectors) {
            const existing = memory.query(domain, SELECTOR_KEY_PREFIX + selector);
            for (const entry of existing) {
              memory.validate(entry.id, false);
              decayed += 1;
            }
          }
          opts.onProcessed?.({ ok: true, decayedSelectors: decayed });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // stderr — never stdout — because the parent MCP server's
        // stdout carries JSON-RPC. A noisy auto-memory hook would
        // corrupt the protocol.
        console.error(
          `[auto-memory] ${record.verdict} record failed (txn=${record.txn_id}, contract=${record.contract_id}): ${error.message}`,
        );
        opts.onProcessed?.({ ok: false, error });
      }
    });
  };

  bus.on('transaction:settled', listener);

  let unregistered = false;
  return {
    unregister(): void {
      if (unregistered) return;
      unregistered = true;
      bus.off('transaction:settled', listener);
    },
  };
}

/**
 * Collect every string at a key literally named `selector` anywhere
 * in `record.pre_evidence.details` and `record.post_evidence.details`.
 * Recurses into nested objects and arrays. Caps the per-selector
 * length so a hostile evaluator that emits megabyte-long pseudo-
 * selectors cannot bloat the DomainMemory store.
 *
 * Returned as a Set so duplicate selectors from pre + post
 * evidence are recorded exactly once per settlement.
 */
function collectSelectors(record: TransactionRecord): Set<string> {
  const out = new Set<string>();
  walkForSelectors(record.pre_evidence?.details, out);
  walkForSelectors(record.post_evidence?.details, out);
  return out;
}

function walkForSelectors(node: unknown, out: Set<string>, depth = 0): void {
  if (node === null || node === undefined) return;
  // Hard recursion cap defends against cyclic / pathologically deep
  // details trees emitted by a buggy evaluator.
  if (depth > 8) return;
  if (Array.isArray(node)) {
    for (const child of node) walkForSelectors(child, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'selector' && typeof value === 'string' && value.length > 0) {
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_SELECTOR_BYTES) continue;
      out.add(trimmed);
      continue;
    }
    walkForSelectors(value, out, depth + 1);
  }
}
