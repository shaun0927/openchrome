/**
 * End-to-end smoke: OM2W adapter output → headline gate (#1427 Part 3).
 *
 * The adapter `toHeadlineRow` lives in TypeScript and is unit-tested in
 * tests/benchmark/datasets/online-mind2web/headline-eligibility.test.ts.
 * ts-jest's CJS runtime cannot import this native-ESM gate, so this script
 * closes the loop from the gate side: it feeds rows shaped exactly like
 * `toHeadlineRow` emits through the real `partitionHeadlineResults` /
 * `requireHeadlineReport` and asserts the gate accepts eligible rows and
 * rejects ineligible ones.
 *
 * Run: node benchmark/om2w-headline-gate.smoke.mjs
 */
import assert from 'node:assert/strict';
import { partitionHeadlineResults, requireHeadlineReport } from './headline-gate.mjs';

// Shape produced by toHeadlineRow for an eligible OM2W run (step_budget=100,
// pinned llm, non-empty evidence/reason).
const eligibleRow = {
  library: 'openchrome',
  taskId: 'om2w-1',
  measurementMode: 'live-llm',
  finalPostconditionEvidence: 'judge marked task complete',
  claimEligibility: { eligible: true, reasons: [], llm: 'gpt-5.4', step_budget: 100 },
};

// Shape produced by toHeadlineRow when ineligible (wrong budget / blank llm /
// no evidence): measurementMode flips to diagnostic and reasons[] is populated.
const diagnosticRow = {
  library: 'openchrome',
  taskId: 'om2w-2',
  measurementMode: 'diagnostic',
  finalPostconditionEvidence: 'judge marked task complete',
  claimEligibility: {
    eligible: false,
    reasons: ['step_budget 50 != published reference 100'],
    llm: 'gpt-5.4',
    step_budget: 50,
  },
};

// Eligible rows partition into the headline bucket.
const onlyEligible = partitionHeadlineResults({ results: [eligibleRow] });
assert.equal(onlyEligible.headline.length, 1, 'eligible row should be headline');
assert.equal(onlyEligible.diagnostic.length, 0);

// Diagnostic rows never reach the headline bucket.
const mixed = partitionHeadlineResults({ results: [eligibleRow, diagnosticRow] });
assert.equal(mixed.headline.length, 1);
assert.equal(mixed.diagnostic.length, 1);
assert.match(mixed.failures[0], /not headline-eligible/);

// An all-eligible OM2W envelope is accepted by the fail-closed gate.
assert.doesNotThrow(() =>
  requireHeadlineReport({ results: [eligibleRow] }, 'OM2W live-llm report'),
);

// A diagnostic-only OM2W envelope is rejected.
assert.throws(
  () => requireHeadlineReport({ results: [diagnosticRow] }, 'OM2W diagnostic report'),
  /contains no headline-eligible rows/,
);

console.log('om2w-headline-gate smoke: OK');
