import assert from 'node:assert/strict';
import { partitionHeadlineResults, requireHeadlineReport } from './headline-gate.mjs';

const headlineRow = {
  library: 'openchrome',
  taskId: 'checkout-product',
  measurementMode: 'recorded-real',
  finalPostconditionEvidence: 'cart contains expected product',
  claimEligibility: { eligible: true, reasons: [] },
};

const diagnosticRow = {
  library: 'browser-use',
  taskId: 'checkout-product',
  mode: 'dry-run',
  finalPostconditionEvidence: 'mock postcondition',
  claimEligibility: { eligible: false, reasons: ['dry-run mode'] },
};

assert.deepEqual(partitionHeadlineResults({ results: [headlineRow] }), {
  headline: [headlineRow],
  diagnostic: [],
  failures: [],
  total: 1,
});

const mixed = partitionHeadlineResults({ results: [headlineRow, diagnosticRow] });
assert.equal(mixed.headline.length, 1);
assert.equal(mixed.diagnostic.length, 1);
assert.match(mixed.failures[0], /dry-run mode/);
assert.match(mixed.failures[0], /not headline-eligible/);

assert.doesNotThrow(() => requireHeadlineReport({ results: [headlineRow] }, 'recorded-real report'));
assert.doesNotThrow(() => requireHeadlineReport({ results: [{ ...headlineRow, measurementMode: 'live-llm' }] }, 'live-llm report'));
assert.doesNotThrow(() => requireHeadlineReport({ results: [{ ...headlineRow, finalPostconditionEvidence: undefined, finalPostconditionEvaluated: true }] }, 'evaluated aggregate report'));
assert.doesNotThrow(() => requireHeadlineReport({ results: [{ ...headlineRow, finalPostconditionEvidence: undefined, runs: [{ finalPostconditionEvidence: 'postcondition checked' }] }] }, 'aggregate with run evidence report'));
assert.doesNotThrow(() => requireHeadlineReport({ results: [{ ...headlineRow, finalPostconditionEvidence: undefined, runs: [{ notes: 'recorded final-postcondition evidence: postcondition checked' }] }] }, 'aggregate with recorded note evidence report'));
assert.throws(() => requireHeadlineReport({ results: [diagnosticRow] }, 'diagnostic-only report'), /contains no headline-eligible rows/);
const skippedPartition = partitionHeadlineResults({ results: [{ ...headlineRow, status: 'skipped' }] });
assert.match(skippedPartition.failures[0], /status skipped is diagnostic-only/);
assert.throws(
  () => requireHeadlineReport({ results: [{ ...headlineRow, status: 'skipped' }] }, 'skipped live report'),
  /contains no headline-eligible rows/,
);
assert.throws(() => requireHeadlineReport({ results: [headlineRow, diagnosticRow] }, 'mixed report'), /diagnostic rows/);
assert.throws(
  () => requireHeadlineReport({ results: [{ ...headlineRow, finalPostconditionEvidence: 'aggregate summary', runs: [{ finalPostconditionEvidence: 'ok' }, { notes: 'missing structured evidence' }] }] }, 'partial aggregate report'),
  /contains no headline-eligible rows/,
);
assert.throws(
  () => requireHeadlineReport({ results: [{ ...headlineRow, finalPostconditionEvidence: '' }] }, 'missing evidence'),
  /contains no headline-eligible rows/,
);
