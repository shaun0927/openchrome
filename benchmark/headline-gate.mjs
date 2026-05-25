#!/usr/bin/env node
/**
 * Final report-time headline gate.
 *
 * Diagnostic benchmark rows are useful for local development, but published
 * competitor comparisons must be backed by claimEligibility metadata and by
 * live or recorded-real execution evidence. This module partitions mixed report
 * envelopes and provides a fail-closed assertion for headline report generation.
 */

const HEADLINE_MODES = new Set(['live', 'live-llm', 'recorded-real']);
const DIAGNOSTIC_STATUSES = new Set(['skipped', 'dependency_missing', 'not_wired', 'dry_run', 'mock', 'scaffold', 'diagnostic']);

function getMode(result) {
  return result?.mode ?? result?.measurementMode ?? result?.metadata?.mode ?? result?.scenario?.mode ?? 'unknown';
}

function getLibrary(result) {
  return result?.library ?? result?.system ?? result?.competitor ?? result?.name ?? 'unknown';
}

function getTaskId(result) {
  return result?.taskId ?? result?.task ?? result?.scenario?.taskId ?? 'unknown';
}

function getStatus(result) {
  return result?.status ?? result?.measurementStatus ?? result?.resultStatus ?? 'unknown';
}

function rowHasPostconditionEvidence(row) {
  const evidence = row?.finalPostconditionEvidence ?? row?.postconditionEvidence ?? row?.evidence?.finalPostcondition;
  const recordedNoteEvidence = typeof row?.notes === 'string' && /^recorded final-postcondition evidence:\s*\S/i.test(row.notes);
  return (typeof evidence === 'string' && evidence.trim().length > 0) || row?.finalPostconditionEvaluated === true || recordedNoteEvidence;
}

function hasPostconditionEvidence(result) {
  if (Array.isArray(result?.runs) && result.runs.length > 0) {
    return result.runs.every(rowHasPostconditionEvidence);
  }
  return rowHasPostconditionEvidence(result);
}

function classifyResult(result, index) {
  const eligibility = result?.claimEligibility;
  const mode = getMode(result);
  const id = `results[${index}] ${getLibrary(result)}/${getTaskId(result)}`;
  const reasons = [];

  if (!eligibility) reasons.push('missing claimEligibility');
  else if (eligibility.eligible !== true) {
    const explicit = Array.isArray(eligibility.reasons) && eligibility.reasons.length > 0
      ? eligibility.reasons.join('; ')
      : 'claimEligibility.eligible is not true';
    reasons.push(explicit);
  }

  if (!HEADLINE_MODES.has(mode)) reasons.push(`mode ${mode} is not headline-eligible`);
  const status = getStatus(result);
  if (DIAGNOSTIC_STATUSES.has(status)) reasons.push(`status ${status} is diagnostic-only`);
  if (!hasPostconditionEvidence(result)) reasons.push('missing final postcondition evidence');

  if (reasons.length > 0) {
    return { bucket: 'diagnostic', id, reasons, result };
  }
  return { bucket: 'headline', id, reasons: [], result };
}

export function partitionHeadlineResults(envelope) {
  const results = Array.isArray(envelope?.results) ? envelope.results : [];
  const headline = [];
  const diagnostic = [];
  const failures = [];

  results.forEach((result, index) => {
    const classified = classifyResult(result, index);
    if (classified.bucket === 'headline') headline.push(result);
    else {
      diagnostic.push(result);
      failures.push(`${classified.id}: ${classified.reasons.join('; ')}`);
    }
  });

  return { headline, diagnostic, failures, total: results.length };
}

export function requireHeadlineReport(envelope, label = 'benchmark report') {
  const partition = partitionHeadlineResults(envelope);
  if (partition.headline.length === 0) {
    throw new Error(`${label} contains no headline-eligible rows`);
  }
  if (partition.failures.length > 0) {
    throw new Error(`${label} contains diagnostic rows that cannot be published as headline claims:\n- ${partition.failures.join('\n- ')}`);
  }
  return partition;
}
