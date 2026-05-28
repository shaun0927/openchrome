/**
 * Tests for the OM2W → headline-gate adapter (#1427 Part 3).
 *
 * Validates the shape produced by `toHeadlineRow` against the
 * documented `benchmark/headline-gate.mjs` contract:
 *   - eligible rows carry `claimEligibility.eligible === true`,
 *     `measurementMode === 'live-llm'`, and `finalPostconditionEvidence`;
 *   - diagnostic rows carry an explanatory `claimEligibility.reasons[]`.
 *
 * The .mjs gate module itself is intentionally not invoked from this
 * .ts test (ts-jest's CJS runtime can't resolve native ESM in this
 * repo). A sibling smoke runbook can wire the produced envelopes
 * through `partitionHeadlineResults` end-to-end.
 */
import {
  toHeadlineRow,
  toHeadlineEnvelope,
  OM2W_REFERENCE_STEP_BUDGET,
} from './headline-eligibility';
import type { RunnerResult } from './runner';

function passResult(taskId = 'om2w-1'): RunnerResult {
  return {
    task_id: taskId,
    passed: true,
    steps_used: 12,
    reason: 'judge marked task complete',
    judge_id: 'host-llm-judge',
    evidence: [
      {
        step: 1,
        tool: 'navigate',
        args: { url: 'https://example.com' },
        ok: true,
        summary: 'navigate',
      },
    ],
  };
}

describe('OM2W headline-eligibility adapter (#1427 Part 3)', () => {
  it('marks a result eligible when step_budget matches and LLM is pinned', () => {
    const row = toHeadlineRow(passResult(), {
      llm: 'gpt-5.4',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
    });
    expect(row.measurementMode).toBe('live-llm');
    expect(row.claimEligibility.eligible).toBe(true);
    expect(row.claimEligibility.reasons).toEqual([]);
    expect(row.finalPostconditionEvidence.length).toBeGreaterThan(0);
    expect(row.claimEligibility.llm).toBe('gpt-5.4');
    expect(row.claimEligibility.step_budget).toBe(OM2W_REFERENCE_STEP_BUDGET);
  });

  it('rejects rows whose step_budget does not match the OM2W reference', () => {
    const row = toHeadlineRow(passResult(), {
      llm: 'gpt-5.4',
      step_budget: 50,
    });
    expect(row.claimEligibility.eligible).toBe(false);
    expect(row.claimEligibility.reasons.join(' ')).toMatch(/step_budget/);
    expect(row.measurementMode).toBe('diagnostic');
  });

  it('rejects rows with no LLM id', () => {
    const row = toHeadlineRow(passResult(), {
      llm: '',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
    });
    expect(row.claimEligibility.eligible).toBe(false);
    expect(row.claimEligibility.reasons.join(' ')).toMatch(/llm id is required/);
  });

  it('rejects rows whose runner produced no evidence', () => {
    const empty: RunnerResult = { ...passResult(), evidence: [] };
    const row = toHeadlineRow(empty, {
      llm: 'gpt-5.4',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
    });
    expect(row.claimEligibility.eligible).toBe(false);
    expect(row.claimEligibility.reasons.join(' ')).toMatch(/no evidence/);
  });

  it('accumulates rows into a single headline envelope', () => {
    const rows = [
      toHeadlineRow(passResult('a'), { llm: 'gpt-5.4', step_budget: OM2W_REFERENCE_STEP_BUDGET }),
      toHeadlineRow(passResult('b'), { llm: 'gpt-5.4', step_budget: OM2W_REFERENCE_STEP_BUDGET }),
    ];
    const envelope = toHeadlineEnvelope(rows);
    expect(envelope.results).toHaveLength(2);
    expect(envelope.results.every((r) => r.claimEligibility.eligible)).toBe(true);
  });

  it('preserves diagnostic notes on rows that carry them', () => {
    const row = toHeadlineRow(passResult(), {
      llm: 'gpt-5.4',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
      note: 'recorded final-postcondition evidence: judge marked task complete',
    });
    expect(row.notes).toMatch(/recorded final-postcondition/);
  });

  it('rejects a row whose runner reason (postcondition evidence) is empty', () => {
    const blank: RunnerResult = { ...passResult(), reason: '   ' };
    const row = toHeadlineRow(blank, {
      llm: 'gpt-5.4',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
    });
    expect(row.claimEligibility.eligible).toBe(false);
    expect(row.claimEligibility.reasons.join(' ')).toMatch(/no final-postcondition evidence/);
    expect(row.measurementMode).toBe('diagnostic');
  });

  it('trims a whitespace-only llm out of claimEligibility.llm', () => {
    const row = toHeadlineRow(passResult(), {
      llm: '   ',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
    });
    expect(row.claimEligibility.eligible).toBe(false);
    expect(row.claimEligibility.llm).toBeUndefined();
  });

  it('eligible rows satisfy every invariant the headline gate reads', () => {
    // Mirrors benchmark/headline-gate.mjs partitionHeadlineResults: an
    // eligible row must resolve to a headline mode and carry non-empty
    // string postcondition evidence. Locks the adapter output to the gate
    // contract from the producer side (the .mjs gate cannot be imported
    // from ts-jest's CJS runtime, so the end-to-end run lives in the
    // sibling om2w-headline-gate.smoke.mjs).
    const row = toHeadlineRow(passResult(), {
      llm: 'gpt-5.4',
      step_budget: OM2W_REFERENCE_STEP_BUDGET,
    });
    expect(row.claimEligibility.eligible).toBe(true);
    expect(['live-llm', 'recorded-real']).toContain(row.measurementMode);
    expect(typeof row.finalPostconditionEvidence).toBe('string');
    expect(row.finalPostconditionEvidence.trim().length).toBeGreaterThan(0);
  });
});
