/**
 * Auto-extractor — bridges `contractRuntimeEvents.transaction:settled`
 * to `recordSuccessfulRun()` so contract-verified successes accrete
 * into SKILL.md candidates without any caller-supplied wiring.
 *
 * Activation chain (every link must be open):
 *   1. `--pilot` (or `OPENCHROME_PILOT=1`) — pilot tier gate.
 *   2. `OPENCHROME_CONTRACT_RUNTIME` (default on inside pilot) — the
 *      runtime that produces `transaction:settled` events.
 *   3. `OPENCHROME_STATE_GRAPH` (default on inside pilot) — produces
 *      the `state_hash` we feed in as `graph_node_anchor`.
 *   4. `OPENCHROME_AUTO_SKILLIFY=1` — explicit opt-in. Off by default
 *      even under `--pilot` because writing to
 *      `~/.openchrome/skills/<domain>/` is a side-effect outside the
 *      request/response lifetime (matches the `isFamilyEnabledOptIn`
 *      precedent in `src/harness/flags.ts`).
 *
 * Selection rule (cheap filter, runs on every settled record):
 *   - `verdict === 'success'` — failures and validation errors are
 *     not promoted, by design.
 *   - `state_hash` present and a non-empty string. Absent means the
 *     state-graph family was disabled or the URL wasn't parseable; in
 *     either case the curator's identity (`graph_node_anchor`)
 *     cannot be derived and the run is skipped (NOT synthesised from
 *     a default — distinct unparseable runs would collapse into the
 *     same anchor).
 *   - `contract_domain` present and non-empty. Skill storage is
 *     domain-partitioned; without a domain there is no place to
 *     write the file.
 *
 * Always-settles preservation:
 *   - `recordSuccessfulRun()` is invoked inside `setImmediate` so the
 *     synchronous emit path through `EventEmitter` returns to the
 *     runtime before any skill file I/O begins.
 *   - Synchronous + asynchronous throws are caught and surfaced on
 *     stderr (NEVER stdout — that carries MCP JSON-RPC).
 */

import {
  contractRuntimeEvents,
  type TypedContractRuntimeEmitter,
} from '../runtime/events.js';
import type { TransactionRecord } from '../runtime/types.js';
import { recordSuccessfulRun, defaultSkillRootDir, type ExtractorOptions } from './extractor.js';
import { recordFailedRun } from './failed-run.js';
import { buildSkillBody, type JournalLikeEntry } from './body-builder.js';

/**
 * Listener handle returned by `registerAutoExtractor()` so callers
 * (notably the pilot bootstrap teardown path used in tests) can stop
 * the subscription cleanly. `unregister()` is idempotent — repeated
 * calls are no-ops, which matters because both `bootstrap()`'s stop
 * handler and a test's `afterEach` may end up calling it.
 */
export interface AutoExtractorHandle {
  unregister(): void;
}

export interface AutoExtractorOptions {
  /** Root directory for the skill tree. Defaults to `~/.openchrome/skills`. */
  rootDir?: string;
  /** Test hook: override the event bus singleton. */
  bus?: TypedContractRuntimeEmitter;
  /**
   * Test hook: forwarded to `recordSuccessfulRun`. Lets tests
   * substitute the clock or the promotion threshold without having
   * to wait for real wall-clock retries.
   */
  extractorOptions?: ExtractorOptions;
  /**
   * Provides the journal entries the body builder consumes when
   * distilling the SKILL.md body. Production wiring uses
   * `defaultJournalProvider` (reads ~/.openchrome/journal). Tests
   * supply a synthetic provider so the body output is deterministic.
   * Returning `undefined` falls back to the placeholder body in
   * `recordSuccessfulRun`.
   */
  journalProvider?: (record: TransactionRecord) => ReadonlyArray<JournalLikeEntry> | undefined;
  /**
   * Test hook: invoked after a `recordSuccessfulRun` attempt
   * completes (success OR failure). Tests use this to await the
   * fire-and-forget `setImmediate` dispatch without resorting to
   * polling sleeps. Production callers leave this undefined.
   */
  onProcessed?: (result: { ok: true } | { ok: false; error: Error }) => void;
}

/**
 * Default journal provider — pulls recent entries (last ~500) from
 * `~/.openchrome/journal/journal-*.jsonl` and filters them down to
 * the transaction's wall-clock window. Returns an empty list rather
 * than `undefined` when the journal singleton is unreachable so the
 * body builder still produces a stable placeholder body.
 */
export function defaultJournalProvider(record: TransactionRecord): ReadonlyArray<JournalLikeEntry> {
  try {
    // Dynamic require so test environments that mock fs don't load
    // the journal singleton at module-import time.
    const { getTaskJournal } = require('../../journal/task-journal') as {
      getTaskJournal: () => { getRecent: (n?: number) => JournalLikeEntry[] };
    };
    const journal = getTaskJournal();
    const recent = journal.getRecent(500);
    const start = record.started_at;
    const end = record.ended_at;
    return recent
      .filter((e) => typeof e?.ts === 'number' && e.ts >= start && e.ts <= end)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

export function registerAutoExtractor(opts: AutoExtractorOptions = {}): AutoExtractorHandle {
  const bus = opts.bus ?? contractRuntimeEvents;
  const rootDir = opts.rootDir ?? defaultSkillRootDir();

  const listener = (record: TransactionRecord): void => {
    const stateHash = record.state_hash;
    if (typeof stateHash !== 'string' || stateHash.length === 0) return;
    const domain = record.contract_domain;
    if (typeof domain !== 'string' || domain.length === 0) return;

    // Success → create / promote skill. Postcondition violations are
    // the only failure verdict we surface to the sidecar — they mean
    // "we tried to run the skill against this state and the contract
    // said no afterwards", which is precisely the fail-rate signal
    // the curator's prune pass needs. Other failure verdicts
    // (execution_error, budget_exhausted, validation_error,
    // escalated, aborted_by_hook) are skipped because they say more
    // about the runner than the skill itself.
    if (record.verdict !== 'success' && record.verdict !== 'postcondition_violation') {
      return;
    }

    // Dispatch off the synchronous emit path so the runtime returns
    // before any disk I/O begins. The runtime has already settled by
    // the time this fires — extractor failure can never rewrite the
    // verdict.
    setImmediate(() => {
      try {
        if (record.verdict === 'success') {
          // Build a deterministic Steps body from the journal slice
          // covering this transaction's wall-clock window. When the
          // journal yields no entries (test environment, or the
          // contract ran before any tool calls) we omit `body` and
          // let `recordSuccessfulRun` fall back to its placeholder.
          const provider = opts.journalProvider ?? defaultJournalProvider;
          let body: string | undefined;
          try {
            const entries = provider(record);
            if (entries && entries.length > 0) {
              body = buildSkillBody(entries, { intent: record.contract_id });
            }
          } catch {
            // Body distillation is best-effort — never fail the
            // recordSuccessfulRun on a body-builder hiccup.
            body = undefined;
          }
          recordSuccessfulRun(
            {
              txn_id: record.txn_id,
              contract_id: record.contract_id,
              // Use the contract id as the human-readable intent
              // label when the runtime did not supply one.
              intent: record.contract_id,
              domain,
              graph_node_anchor: stateHash,
              ...(body !== undefined ? { body } : {}),
            },
            { rootDir, ...(opts.extractorOptions ?? {}) },
          );
        } else {
          // Failure path — only logs against existing skills, never
          // creates new ones. See `failed-run.ts` for the semantics.
          recordFailedRun(
            {
              txn_id: record.txn_id,
              contract_id: record.contract_id,
              domain,
              graph_node_anchor: stateHash,
            },
            { rootDir, ...(opts.extractorOptions ?? {}) },
          );
        }
        opts.onProcessed?.({ ok: true });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // stderr — never stdout — because the parent MCP server's
        // stdout carries JSON-RPC. A noisy auto-extractor would
        // corrupt the protocol.
        console.error(
          `[auto-skillify] ${record.verdict} record failed (txn=${record.txn_id}, contract=${record.contract_id}): ${error.message}`,
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
