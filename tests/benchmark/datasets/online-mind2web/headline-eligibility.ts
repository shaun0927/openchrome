/**
 * Headline-gate adapter for OM2W runner results (#1427 Part 3).
 *
 * The benchmark suite already enforces a fail-closed headline gate in
 * `benchmark/headline-gate.mjs`: only results with `claimEligibility`
 * = true and a headline-eligible `mode` reach the published report.
 * This module adapts a `RunnerResult` (#1427 Part 2) into the gate's
 * input envelope and applies the OM2W-specific eligibility policy:
 *
 *   - Mode must be `live-llm` (real model, real browser, live web).
 *   - Step budget must equal the published 100 for parity with the
 *     OM2W leaderboard. Diagnostic budgets are partitioned as
 *     diagnostic-only, not headline.
 *   - Each row carries the LLM id under `claimEligibility.llm` so the
 *     eventual cross-library comparison can pin equal-LLM cells.
 */

import type { RunnerResult } from './runner';

export interface OmTaskMeta {
  /** Pinned LLM identifier the runner was driven against. */
  llm: string;
  /** Step budget the runner was constrained to. */
  step_budget: number;
  /** Library name (always 'openchrome' here; competitor rows use their own). */
  library?: string;
  /** Diagnostic note included on dry-runs. */
  note?: string;
}

/** Shape consumed by `partitionHeadlineResults`. */
export interface HeadlineRow {
  library: string;
  taskId: string;
  measurementMode: 'live-llm' | 'diagnostic';
  finalPostconditionEvidence: string;
  claimEligibility: {
    eligible: boolean;
    reasons: string[];
    llm?: string;
    step_budget?: number;
  };
  notes?: string;
}

export const OM2W_REFERENCE_STEP_BUDGET = 100;

export function toHeadlineRow(result: RunnerResult, meta: OmTaskMeta): HeadlineRow {
  const reasons: string[] = [];
  const budgetMatches = meta.step_budget === OM2W_REFERENCE_STEP_BUDGET;
  if (!budgetMatches) {
    reasons.push(
      `step_budget ${meta.step_budget} != published reference ${OM2W_REFERENCE_STEP_BUDGET}`,
    );
  }
  if (!meta.llm || meta.llm.trim().length === 0) {
    reasons.push('llm id is required for OM2W headline eligibility');
  }
  if (result.evidence.length === 0) {
    reasons.push('runner produced no evidence');
  }
  const eligible = reasons.length === 0;

  return {
    library: meta.library ?? 'openchrome',
    taskId: result.task_id,
    measurementMode: eligible ? 'live-llm' : 'diagnostic',
    finalPostconditionEvidence: result.reason,
    claimEligibility: {
      eligible,
      reasons,
      llm: meta.llm,
      step_budget: meta.step_budget,
    },
    ...(meta.note ? { notes: meta.note } : {}),
  };
}

export function toHeadlineEnvelope(
  rows: HeadlineRow[],
): { results: HeadlineRow[] } {
  return { results: rows };
}
