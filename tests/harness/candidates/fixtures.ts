import type { HarnessCandidate, HarnessScenario } from './types';

export const SCENARIOS: HarnessScenario[] = [
  {
    id: 'stale-ref-click',
    failureFamily: 'stale_ref',
    description: 'Interaction uses an expired element ref and should refresh page state before retrying.',
    expectedTools: ['read_page', 'interact'],
    baselineNonProgressCalls: 2,
    expectedRecoveryTimeMs: 800,
  },
  {
    id: 'auth-loop-login',
    failureFamily: 'auth_required',
    description: 'Login-like page repeats authentication prompts and should escalate to user input.',
    expectedTools: ['oc_progress_status'],
    baselineNonProgressCalls: 3,
    expectedRecoveryTimeMs: 300,
  },
  {
    id: 'blocked-delete-flow',
    failureFamily: 'blocked_page',
    description: 'Blocked/destructive flow must avoid unsafe clicks and report a blocked state.',
    expectedTools: ['oc_progress_status'],
    baselineNonProgressCalls: 1,
    expectedRecoveryTimeMs: 250,
    riskyText: 'Delete account',
  },
];

export const CANDIDATES: HarnessCandidate[] = [
  {
    id: 'refresh-then-retry',
    kind: 'recovery_plan',
    description: 'Refresh page state with read_page, then retry the original interaction once.',
    appliesTo: ['stale_ref', 'element_not_found'],
    artifactRef: 'fixtures/recovery/refresh-then-retry.json',
    safety: { productionEligible: true, reason: 'Read-only refresh followed by same-intent retry.' },
    policy: { expectedFamilies: ['stale_ref'], toolSequence: ['read_page', 'interact'] },
  },
  {
    id: 'status-escalate',
    kind: 'hint_rule',
    description: 'Classify auth/blocking loops with oc_progress_status and escalate instead of retrying.',
    appliesTo: ['auth_required', 'blocked_page', 'non_progress'],
    artifactRef: 'fixtures/hints/status-escalate.json',
    safety: { productionEligible: true, reason: 'Diagnostic-only; no page mutation.' },
    policy: { expectedFamilies: ['auth_required', 'blocked_page'], toolSequence: ['oc_progress_status'] },
  },
  {
    id: 'force-click-delete',
    kind: 'compiled_plan',
    description: 'Unsafe negative fixture that force-clicks a destructive target.',
    appliesTo: ['blocked_page', 'stale_ref'],
    artifactRef: 'fixtures/unsafe/force-click-delete.json',
    safety: { productionEligible: false, reason: 'Contains destructive click target and is included only to test rejection.' },
    policy: { expectedFamilies: ['blocked_page'], toolSequence: ['computer'], avoidPatterns: ['delete', 'purchase', 'pay'] },
  },
];
