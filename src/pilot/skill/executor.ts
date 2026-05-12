/**
 * Pilot-tier skill graph executor — pure decision function.
 *
 * Issue #820 (blocks #717). Restores the runtime piece that the v1.11
 * portability-harness pivot left unimplemented after closing PR #739 /
 * issue #703 ("Graph executor with resume-from-state"). The previous
 * authoring shipped a full loop runner that owned action dispatch; this
 * re-author honours portability-harness clause P4 (facts vs decisions) by
 * shrinking the surface to a side-effect-free recommendation function the
 * host invokes between MCP tool calls.
 *
 * The function consumes the JSON-per-domain `SkillGraphStorage` from
 * `src/core/skill/` (#801). All reads are synchronous and tolerant of an
 * empty, corrupted, or partially-populated graph — `decide()` always
 * settles, never throws.
 *
 * Activation: call sites MUST gate on `isStateGraphEnabled()` from
 * `src/harness/flags.ts` before invoking. The module is loaded only when
 * `bootstrapPilot()` runs (i.e. `--pilot` is set); the per-family flag
 * guards behavioural use within the pilot tier so a host can keep
 * `--pilot` open for some families while leaving state-graph closed.
 */

import { SkillGraphStorage } from '../../core/skill/index.js';
import type { SkillEdge } from '../../core/skill/index.js';
import type {
  ExecutorAction,
  ExecutorDecision,
  ExecutorInput,
} from './types.js';

/**
 * Top-of-distribution count must reach at least this share of the edge's
 * total observed invocations before we trust it as a "this action led
 * here" signal. Preserved verbatim from closed PR #739 v2 for behavioural
 * continuity with the original epic.
 */
export const DISTRIBUTION_MATCH_THRESHOLD = 0.1;

/**
 * Under this total invocation count the share threshold is too noisy, so
 * we fall back to an absolute-count rule (top.count >= 1).
 */
export const SMALL_SAMPLE_TOTAL = 10;

/**
 * Minimum success rate required to recommend a candidate. Edges with a
 * lower rate fall through to the `host_decides` outcome — the host then
 * runs its own waterfall and the storage records a fresh outcome that
 * eventually pushes the rate above or below the floor.
 */
export const RECOMMEND_RATE_FLOOR = 0.5;

/**
 * Composite-key delimiter for de-duplicating candidates and indexing the
 * snapshot. ASCII Unit Separator (U+001F) is used as an escape sequence
 * so the source file stays text-friendly (no raw control byte on disk —
 * Git, grep, and review tooling treat the module as text).
 */
const KEY_DELIM = '\u001F';

interface MatchedEdge {
  candidate: ExecutorAction;
  edge: SkillEdge;
}

interface BestMatch {
  candidate: ExecutorAction;
  rate: number;
  total: number;
  successCount: number;
}

/**
 * Decide what to do next given the current page state and a candidate
 * action list. The return value is one of three shapes:
 *
 * - `already_at_target`: the graph shows at least one candidate has
 *   historically landed at `currentStateHash`, so the host can skip it
 *   without observable behaviour change.
 * - `recommended`: at least one candidate has a confident success record
 *   from `currentStateHash`; the host should try it first.
 * - `host_decides`: cold graph, no matching edges, low confidence, or
 *   input validation failure. Host falls back to its waterfall.
 *
 * The function is total — never throws. Invalid inputs or storage errors
 * always settle as `host_decides` with a `reason` string that surfaces in
 * audit and debug.
 */
export function decide(
  input: ExecutorInput,
  storage: SkillGraphStorage,
): ExecutorDecision {
  if (!input || typeof input !== 'object') {
    return { kind: 'host_decides', reason: 'invalid_input' };
  }
  if (typeof input.domain !== 'string' || input.domain.length === 0) {
    return { kind: 'host_decides', reason: 'invalid_domain' };
  }
  if (
    typeof input.currentStateHash !== 'string' ||
    input.currentStateHash.length === 0
  ) {
    return { kind: 'host_decides', reason: 'invalid_state_hash' };
  }
  if (
    !Array.isArray(input.candidateActions) ||
    input.candidateActions.length === 0
  ) {
    return { kind: 'host_decides', reason: 'empty_candidate_actions' };
  }
  if (
    !storage ||
    typeof storage.getEdgesFromStateSync !== 'function'
  ) {
    return { kind: 'host_decides', reason: 'invalid_storage' };
  }
  if (storage.domain !== input.domain) {
    return { kind: 'host_decides', reason: 'storage_domain_mismatch' };
  }

  let matches: MatchedEdge[];
  try {
    matches = collectMatchedEdges(input, storage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'host_decides', reason: `storage_error: ${message}` };
  }

  if (matches.length === 0) {
    return { kind: 'host_decides', reason: 'no_matching_edges' };
  }

  for (const match of matches) {
    if (looksLikeAlreadyAtTarget(match.edge, input.currentStateHash)) {
      return {
        kind: 'already_at_target',
        skipUntil: input.currentStateHash,
        reason: formatSkipReason(match.candidate),
      };
    }
  }

  const best = pickBestRecommendation(matches);
  if (best) {
    return {
      kind: 'recommended',
      recommended: best.candidate,
      reason: formatRecommendReason(best),
    };
  }

  return { kind: 'host_decides', reason: 'no_confident_candidate' };
}

/**
 * Builds the matched-edge list from one coherent graph snapshot. The
 * snapshot is read once via `getEdgesFromStateSync` so that concurrent
 * writers cannot leave us comparing edges from different graph versions
 * — see PR #823 review (Codex), "Read edge data from a single graph
 * snapshot".
 */
function collectMatchedEdges(
  input: ExecutorInput,
  storage: SkillGraphStorage,
): MatchedEdge[] {
  const edgesFromState = storage.getEdgesFromStateSync(
    input.currentStateHash,
  );
  const byActionKey = new Map<string, SkillEdge>();
  for (const edge of edgesFromState) {
    const key = `${edge.actionKind}${KEY_DELIM}${edge.actionArgsNorm}`;
    if (!byActionKey.has(key)) byActionKey.set(key, edge);
  }

  const out: MatchedEdge[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidateActions) {
    if (
      !candidate ||
      typeof candidate.kind !== 'string' ||
      candidate.kind.length === 0 ||
      typeof candidate.argsNorm !== 'string'
    ) {
      // Skip malformed candidates without poisoning the whole decision.
      continue;
    }
    const key = `${candidate.kind}${KEY_DELIM}${candidate.argsNorm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const edge = byActionKey.get(key);
    if (edge) out.push({ candidate, edge });
  }
  return out;
}

function looksLikeAlreadyAtTarget(
  edge: SkillEdge,
  currentStateHash: string,
): boolean {
  const dist = edge.toStateDistribution;
  if (!Array.isArray(dist) || dist.length === 0) return false;
  const top = dist[0];
  if (!top || top.to_state !== currentStateHash) return false;
  const total = edge.successCount + edge.failCount;
  if (total >= SMALL_SAMPLE_TOTAL) {
    return top.count / total >= DISTRIBUTION_MATCH_THRESHOLD;
  }
  return top.count >= 1;
}

function pickBestRecommendation(matches: MatchedEdge[]): BestMatch | null {
  let best: BestMatch | null = null;
  for (const match of matches) {
    const total = match.edge.successCount + match.edge.failCount;
    if (total === 0) continue;
    const rate = match.edge.successCount / total;
    if (rate < RECOMMEND_RATE_FLOOR) continue;
    const candidate: BestMatch = {
      candidate: match.candidate,
      rate,
      total,
      successCount: match.edge.successCount,
    };
    if (best === null) {
      best = candidate;
      continue;
    }
    if (rate > best.rate) {
      best = candidate;
      continue;
    }
    if (rate === best.rate && candidate.successCount > best.successCount) {
      best = candidate;
    }
  }
  return best;
}

function formatSkipReason(candidate: ExecutorAction): string {
  return `candidate ${candidate.kind}/${candidate.argsNorm} historically lands at current state`;
}

function formatRecommendReason(best: BestMatch): string {
  const rate = best.rate.toFixed(2);
  return `candidate ${best.candidate.kind}/${best.candidate.argsNorm} successRate=${rate} n=${best.total}`;
}
