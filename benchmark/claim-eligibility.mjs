#!/usr/bin/env node
/**
 * Shared report-time claim eligibility gate (#1310).
 *
 * Generated benchmark reports may contain diagnostic rows, but a publishable
 * headline claim must carry explicit claimEligibility metadata and be eligible.
 */

export function findClaimEligibilityFailures(envelope) {
  const failures = [];
  const results = Array.isArray(envelope?.results) ? envelope.results : [];
  results.forEach((result, index) => {
    const eligibility = result?.claimEligibility;
    if (!eligibility) {
      failures.push(`results[${index}] missing claimEligibility`);
      return;
    }
    if (eligibility.eligible !== true) {
      const reasons = Array.isArray(eligibility.reasons) ? eligibility.reasons.join('; ') : 'unknown reason';
      failures.push(`results[${index}] not headline eligible: ${reasons}`);
    }
  });
  return failures;
}

export function requireHeadlineEligibility(envelope, label = 'benchmark result') {
  const failures = findClaimEligibilityFailures(envelope);
  if (failures.length > 0) {
    throw new Error(`${label} cannot be used for headline claims:\n- ${failures.join('\n- ')}`);
  }
}
