/**
 * Failed-run sidecar logger — companion to `recordSuccessfulRun`.
 *
 * `recordSuccessfulRun()` (`extractor.ts:367`) is the existing entry
 * point that creates / promotes skill files. It only ever appends
 * `ok: true` entries to the rolling sidecar log. To make the
 * curator's prune pass observe real fail rates we need the symmetric
 * `ok: false` side too — that's this module.
 *
 * Semantics (deliberately narrower than the success path):
 *   - Only existing skills get a failure entry. If no SKILL.md /
 *     sidecar exists for the `(graph_node_anchor, contract_id)`
 *     pair, the call is a no-op. Rationale: a failure on a state
 *     the agent has never succeeded against doesn't yet correspond
 *     to a candidate skill — there's no fail-rate to compute against.
 *   - Frontmatter is untouched: `verified_runs`, `status`,
 *     `last_verified_at`, `contract_ref` all stay on whatever the
 *     last successful run wrote. The curator's prune sub-pass reads
 *     fail rates from the sidecar's rolling log, not from
 *     frontmatter, so we keep the human-readable record stable.
 *   - Idempotent on `txn_id`: re-emitting the same `(txn_id, ok)`
 *     pair appends nothing the second time. Without this guard,
 *     auto-extractor retries on transient I/O could double-count
 *     failures and force a promoted skill into a demote loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSkillMd } from './skill-md.js';
import {
  assertSafeDomain,
  computeSkillId,
  defaultSkillRootDir,
  type ExtractorOptions,
} from './extractor.js';
import {
  SKILL_RUN_LOG_MAX,
  SKILL_SCHEMA_VERSION,
  type SkillSidecar,
} from './types.js';

const ROLLING_WINDOW_DAYS = 30;
const ROLLING_WINDOW_MS = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface FailedRunInputs {
  /** Settled transaction id used as the audit reference. */
  txn_id: string;
  /** Contract id this transaction settled under. */
  contract_id: string;
  /** Hex state-hash matching the skill's `graph_node_anchor`. */
  graph_node_anchor: string;
  /** eTLD+1 host the skill is stored under. */
  domain: string;
}

export interface FailedRunResult {
  /** True iff the entry was appended (i.e. a matching skill existed
   *  AND the txn_id was new). */
  recorded: boolean;
  /** Path of the SKILL.md we touched (for diagnostics). */
  filePath?: string;
}

function isoUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function writeAtomic(target: string, body: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o644 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Append a failure entry to the rolling sidecar log for an existing
 * skill identified by `(graph_node_anchor, contract_id)`. Returns
 * `{ recorded: false }` when no such skill exists yet, or when the
 * same `txn_id` has already been logged.
 *
 * Does not acquire the curator file lock — `withSkillLock` lives in
 * `extractor.ts` and is private; this function uses an atomic
 * fs.writeFile to avoid partial writes. Concurrent failure writes
 * for the same skill are rare in practice (a single contract emits
 * exactly one verdict per run) and the rolling-log cap absorbs any
 * brief race-induced duplication on the next trim.
 */
export function recordFailedRun(
  inputs: FailedRunInputs,
  opts: ExtractorOptions = {},
): FailedRunResult {
  const rootDir = opts.rootDir ?? defaultSkillRootDir();
  const now = (opts.now ?? Date.now)();
  assertSafeDomain(inputs.domain);
  const skillId = computeSkillId(inputs.graph_node_anchor, inputs.contract_id);
  const domainDir = path.join(rootDir, inputs.domain);
  const filePath = path.join(domainDir, `${skillId}.md`);
  const sidecarPath = path.join(domainDir, `${skillId}.json`);

  if (!fs.existsSync(filePath) || !fs.existsSync(sidecarPath)) {
    return { recorded: false };
  }

  // Parse existing markdown to confirm the skill record is sane;
  // bail without touching disk on parse failure rather than
  // overwriting a malformed file with new state.
  try {
    parseSkillMd(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { recorded: false };
  }

  let sidecar: SkillSidecar;
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as SkillSidecar;
  } catch {
    return { recorded: false };
  }
  if (!sidecar.runs || !Array.isArray(sidecar.runs.recent)) {
    return { recorded: false };
  }

  // Idempotency guard: skip if this txn already appears.
  for (const e of sidecar.runs.recent) {
    if (e?.txn_id === inputs.txn_id) {
      return { recorded: false };
    }
  }

  const windowStartMs = now - ROLLING_WINDOW_MS;
  const appended = [...sidecar.runs.recent, { txn_id: inputs.txn_id, ok: false, ts: now }];
  const recent = appended.filter((e) => e.ts >= windowStartMs).slice(-SKILL_RUN_LOG_MAX);

  // `runs.count` continues to mean "successes in window" — keep the
  // prior value unless the trim drops a prior success entry.
  const successesAfterTrim = recent.filter((e) => e.ok).length;
  const updated: SkillSidecar = {
    schema_version: SKILL_SCHEMA_VERSION,
    skill_id: skillId,
    graph_node_anchor: inputs.graph_node_anchor,
    contract_id: inputs.contract_id,
    runs: {
      count: successesAfterTrim,
      window_start: isoUtc(windowStartMs),
      recent,
    },
  };
  writeAtomic(sidecarPath, JSON.stringify(updated, null, 2));
  return { recorded: true, filePath };
}
