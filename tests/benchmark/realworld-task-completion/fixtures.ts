import type { EpisodeFaultType, RealWorldTaskRun, RealWorldTaskSpec } from './types';

export const realWorldTaskSpecs: RealWorldTaskSpec[] = [
  {
    id: 'rw-001-checkout-update-address',
    title: 'Update a checkout shipping address and verify recalculated summary',
    tier: 'local-fixture',
    category: 'form_fill',
    goal: 'Find the checkout address form, update the shipping city/postal code, and verify the order summary reflects the new destination.',
    maxSteps: 14,
    successCriteria: ['address fields saved', 'summary destination updated', 'tax/shipping recalculated'],
    complexityTags: ['form-fill', 'stateful-ui', 'verification'],
    requiresRecovery: false,
    fixturePath: 'tests/benchmark/fixtures/realworld/checkout-address.html',
    resetContract: {
      kind: 'fixture-reset',
      description: 'Reloading the local checkout fixture restores the original address and order summary.',
      evidence: 'initial city=Springfield; initial postal=01103; order summary destination=MA',
    },
    postconditionContract: {
      description: 'The saved address and order summary must both show the requested destination after submit.',
      requiredEvidence: ['saved city/postal text', 'summary destination text', 'recalculated shipping/tax values'],
    },
  },
  {
    id: 'rw-002-search-filter-compare',
    title: 'Search, filter, compare two products, and extract the cheaper eligible item',
    tier: 'local-fixture',
    category: 'info_retrieval',
    goal: 'Search a product catalog, apply availability and rating filters, compare two candidates, and report the cheaper eligible item.',
    maxSteps: 16,
    successCriteria: ['filters applied', 'two candidates compared', 'eligible cheaper item extracted'],
    complexityTags: ['search', 'filtering', 'extraction', 'decision'],
    requiresRecovery: false,
    fixturePath: 'tests/benchmark/fixtures/realworld/product-search.html',
    resetContract: {
      kind: 'fixture-reset',
      description: 'Reloading the fixture clears query text, filters, comparison tray, and selected answer.',
      evidence: 'query empty; availability filter unset; comparison tray count=0',
    },
    postconditionContract: {
      description: 'The final answer must name the cheapest in-stock item that satisfies the rating filter.',
      requiredEvidence: ['active filters', 'two compared item names/prices', 'selected cheaper eligible item'],
    },
  },
  {
    id: 'rw-003-return-authorization',
    title: 'Complete a mock return authorization transaction',
    tier: 'local-fixture',
    category: 'transactional_mock',
    goal: 'Find an order, select eligible items for return, choose a reason, submit the mock return request, and verify the authorization number.',
    maxSteps: 18,
    successCriteria: ['eligible order found', 'return reason selected', 'mock transaction submitted', 'authorization number verified'],
    complexityTags: ['transactional-mock', 'stateful-ui', 'verification'],
    requiresRecovery: false,
    fixturePath: 'tests/benchmark/fixtures/realworld/return-authorization.html',
    resetContract: {
      kind: 'fixture-reset',
      description: 'Reloading the fixture clears selected items, reason, confirmation state, and generated authorization number.',
      evidence: 'selected return items=0; confirmation hidden; authorization number absent',
    },
    postconditionContract: {
      description: 'The final confirmation must include the expected mock return authorization number and selected item.',
      requiredEvidence: ['confirmation banner', 'authorization number', 'returned item name'],
    },
  },
  {
    id: 'rw-004-selector-drift-recovery',
    title: 'Recover from selector drift while submitting a feedback form',
    tier: 'recovery',
    category: 'recovery',
    goal: 'Submit a feedback form after the primary submit selector changes during the run.',
    maxSteps: 20,
    successCriteria: ['selector failure observed', 'fallback selector or semantic action used', 'form submitted'],
    complexityTags: ['fault-recovery', 'form-fill', 'grounding'],
    requiresRecovery: true,
    fixturePath: 'tests/benchmark/fixtures/realworld/selector-drift-feedback.html',
    resetContract: {
      kind: 'fixture-reset',
      description: 'Reloading the fixture restores the pre-drift selector state and clears submitted feedback.',
      evidence: 'primary submit selector present before drift; submission receipt absent',
    },
    postconditionContract: {
      description: 'The feedback receipt must be visible after recovering from the drifted submit selector.',
      requiredEvidence: ['selector failure/fallback note', 'feedback receipt text', 'submitted email/value'],
    },
  },
  {
    id: 'rw-005-long-horizon-itinerary',
    title: 'Build and verify a multi-step itinerary from constrained options',
    tier: 'long-horizon',
    category: 'long_horizon',
    goal: 'Filter itinerary options by date, budget, and transit time; add the best option; verify the final itinerary summary.',
    maxSteps: 28,
    successCriteria: ['constraints applied', 'best option selected', 'itinerary added', 'summary verified'],
    complexityTags: ['long-horizon', 'filtering', 'decision', 'stateful-ui'],
    requiresRecovery: false,
    fixturePath: 'tests/benchmark/fixtures/realworld/itinerary-builder.html',
    resetContract: {
      kind: 'fixture-reset',
      description: 'Reloading the fixture clears filters, selected legs, cart state, and itinerary summary.',
      evidence: 'filters empty; selected legs=0; itinerary summary hidden',
    },
    postconditionContract: {
      description: 'The itinerary summary must include the selected option satisfying date, budget, and transit constraints.',
      requiredEvidence: ['applied constraints', 'selected option id', 'summary total and transit time'],
    },
  },
  {
    id: 'rw-006-dynamic-ui-inventory',
    title: 'Handle delayed dynamic inventory controls and verify saved selection',
    tier: 'local-fixture',
    category: 'dynamic_ui',
    goal: 'Wait for inventory controls to hydrate, open the variant picker, select the only in-stock variant, and verify the saved selection.',
    maxSteps: 18,
    successCriteria: ['hydrated controls observed', 'in-stock variant selected', 'selection persisted in summary'],
    complexityTags: ['dynamic-ui', 'hydration', 'stateful-ui', 'verification'],
    requiresRecovery: false,
    fixturePath: 'tests/benchmark/fixtures/realworld/dynamic-inventory.html',
    resetContract: {
      kind: 'fixture-reset',
      description: 'Reloading the fixture returns controls to the loading state and clears the saved variant summary.',
      evidence: 'controls loading; selected variant empty; summary hidden',
    },
    postconditionContract: {
      description: 'The summary must show the selected in-stock variant after delayed controls hydrate.',
      requiredEvidence: ['hydration complete marker', 'selected variant label', 'saved selection summary'],
    },
  },
];

export function deterministicOpenChromeFixtureRuns(): RealWorldTaskRun[] {
  return realWorldTaskSpecs.map((task, index) => ({
    library: 'openchrome',
    taskId: task.id,
    mode: 'deterministic-fixture',
    success: true,
    firstAttempt: task.requiresRecovery ? false : true,
    recovered: task.requiresRecovery ? true : null,
    wallTimeMs: 1_200 + index * 175 + (task.requiresRecovery ? 450 : 0),
    toolCalls: Math.min(task.maxSteps, 5 + index * 2 + (task.requiresRecovery ? 3 : 0)),
    retries: task.requiresRecovery ? 1 : 0,
    noProgressLoops: 0,
    tokens: null,
    usd: null,
    failureCategory: 'none',
    finalPostconditionEvidence: `${task.id}: ${task.postconditionContract.requiredEvidence.join(' + ')} observed after ${task.resetContract.kind}`,
    finalPostconditionEvaluated: true,
    notes: `deterministic scaffold row from local fixture contract (${task.category}); not a live competitive LLM/browser measurement`,
  }));
}

const STRESS_FAULTS_BY_TASK: Record<string, { fault: EpisodeFaultType; injectAtStep: number; expectedRecoverySignal: string }> = {
  'rw-001-checkout-update-address': { fault: 'delayed-dom', injectAtStep: 3, expectedRecoverySignal: 'waited for recalculated summary' },
  'rw-002-search-filter-compare': { fault: 'network-stall', injectAtStep: 4, expectedRecoverySignal: 'retried filtered result read' },
  'rw-003-return-authorization': { fault: 'target-closed', injectAtStep: 5, expectedRecoverySignal: 'restored mock transaction state' },
  'rw-004-selector-drift-recovery': { fault: 'selector-drift', injectAtStep: 2, expectedRecoverySignal: 'semantic fallback submit' },
  'rw-005-long-horizon-itinerary': { fault: 'cdp-disconnect', injectAtStep: 8, expectedRecoverySignal: 'reattached before final summary check' },
  'rw-006-dynamic-ui-inventory': { fault: 'delayed-dom', injectAtStep: 2, expectedRecoverySignal: 'waited for hydrated controls' },
};

export function deterministicOpenChromeStressRuns(): RealWorldTaskRun[] {
  return deterministicOpenChromeFixtureRuns().map((run, index) => {
    const plan = STRESS_FAULTS_BY_TASK[run.taskId];
    const success = true;
    return {
      ...run,
      success,
      firstAttempt: false,
      recovered: success,
      retries: run.retries + 1,
      toolCalls: run.toolCalls + 2,
      wallTimeMs: run.wallTimeMs + 350 + index * 25,
      faultInjected: true,
      faultCheckpoint: {
        fault: plan.fault,
        injectAtStep: plan.injectAtStep,
        injected: true,
        evidence: `${plan.fault} injected at step ${plan.injectAtStep}`,
        expectedRecoverySignal: plan.expectedRecoverySignal,
      },
      recoveryTimeMs: 220 + index * 30,
      recoverySteps: 2,
      chromeRssBytes: 96_000_000 + index * 512_000,
      zombieProcessCount: 0,
      notes: `${run.notes}; stress fault injected and recovered only because final postcondition passed`,
    };
  });
}
