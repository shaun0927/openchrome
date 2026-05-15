import type { RealWorldTaskRun, RealWorldTaskSpec } from './types';

export const realWorldTaskSpecs: RealWorldTaskSpec[] = [
  {
    id: 'rw-001-checkout-update-address',
    title: 'Update a checkout shipping address and verify recalculated summary',
    tier: 'local-fixture',
    goal: 'Find the checkout address form, update the shipping city/postal code, and verify the order summary reflects the new destination.',
    maxSteps: 14,
    successCriteria: ['address fields saved', 'summary destination updated', 'tax/shipping recalculated'],
    complexityTags: ['form-fill', 'stateful-ui', 'verification'],
    requiresRecovery: false,
  },
  {
    id: 'rw-002-search-filter-compare',
    title: 'Search, filter, compare two products, and extract the cheaper eligible item',
    tier: 'local-fixture',
    goal: 'Search a product catalog, apply availability and rating filters, compare two candidates, and report the cheaper eligible item.',
    maxSteps: 16,
    successCriteria: ['filters applied', 'two candidates compared', 'eligible cheaper item extracted'],
    complexityTags: ['search', 'filtering', 'extraction', 'decision'],
    requiresRecovery: false,
  },
  {
    id: 'rw-003-tab-research-synthesis',
    title: 'Use multiple tabs to synthesize two reference pages into one answer',
    tier: 'stable-public-reference',
    goal: 'Open two reference pages, extract the requested facts from each, and produce a synthesized answer with both facts.',
    maxSteps: 18,
    successCriteria: ['two tabs used', 'fact from page A extracted', 'fact from page B extracted', 'combined answer produced'],
    complexityTags: ['tabs', 'reading', 'synthesis'],
    requiresRecovery: false,
  },
  {
    id: 'rw-004-selector-drift-recovery',
    title: 'Recover from selector drift while submitting a feedback form',
    tier: 'recovery',
    goal: 'Submit a feedback form after the primary submit selector changes during the run.',
    maxSteps: 20,
    successCriteria: ['selector failure observed', 'fallback selector or semantic action used', 'form submitted'],
    complexityTags: ['fault-recovery', 'form-fill', 'grounding'],
    requiresRecovery: true,
  },
  {
    id: 'rw-005-long-horizon-itinerary',
    title: 'Build and verify a multi-step itinerary from constrained options',
    tier: 'long-horizon',
    goal: 'Filter itinerary options by date, budget, and transit time; add the best option; verify the final itinerary summary.',
    maxSteps: 28,
    successCriteria: ['constraints applied', 'best option selected', 'itinerary added', 'summary verified'],
    complexityTags: ['long-horizon', 'filtering', 'decision', 'stateful-ui'],
    requiresRecovery: false,
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
    notes: 'deterministic scaffold row from local fixture contract; not a live competitive LLM/browser measurement',
  }));
}
