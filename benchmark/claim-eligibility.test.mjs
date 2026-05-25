import assert from 'node:assert/strict';
import { findClaimEligibilityFailures, requireHeadlineEligibility } from './claim-eligibility.mjs';

const eligible = { results: [{ claimEligibility: { eligible: true, reasons: [] } }] };
const missing = { results: [{}] };
const diagnostic = { results: [{ claimEligibility: { eligible: false, reasons: ['mock mode'] } }] };

assert.deepEqual(findClaimEligibilityFailures(eligible), []);
assert.match(findClaimEligibilityFailures(missing)[0], /missing claimEligibility/);
assert.match(findClaimEligibilityFailures(diagnostic)[0], /mock mode/);
assert.doesNotThrow(() => requireHeadlineEligibility(eligible, 'eligible'));
assert.throws(() => requireHeadlineEligibility(diagnostic, 'diagnostic'), /cannot be used for headline claims/);
