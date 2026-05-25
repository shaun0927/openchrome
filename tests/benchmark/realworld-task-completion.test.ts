/// <reference types="jest" />

import { buildRealWorldTaskCompletionResult } from './run-realworld-task-completion';
import { deterministicOpenChromeFixtureRuns, realWorldTaskSpecs } from './realworld-task-completion/fixtures';
import type { RealWorldTaskCategory } from './realworld-task-completion/types';

describe('controlled real-world task corpus contracts', () => {
  test('covers the full controlled task taxonomy with reset and postcondition contracts', () => {
    const categories = new Set(realWorldTaskSpecs.map((task) => task.category));
    const required: RealWorldTaskCategory[] = [
      'info_retrieval',
      'form_fill',
      'transactional_mock',
      'recovery',
      'dynamic_ui',
      'long_horizon',
    ];

    for (const category of required) expect(categories.has(category)).toBe(true);
    expect(realWorldTaskSpecs.every((task) => task.fixturePath.length > 0)).toBe(true);
    expect(realWorldTaskSpecs.every((task) => task.resetContract.kind === 'fixture-reset')).toBe(true);
    expect(realWorldTaskSpecs.every((task) => task.resetContract.evidence.length > 0)).toBe(true);
    expect(realWorldTaskSpecs.every((task) => task.postconditionContract.requiredEvidence.length > 0)).toBe(true);
  });

  test('deterministic fixture runs carry final postcondition evidence for every task', () => {
    const runs = deterministicOpenChromeFixtureRuns();
    expect(runs).toHaveLength(realWorldTaskSpecs.length);
    expect(runs.every((run) => run.finalPostconditionEvaluated === true)).toBe(true);
    expect(runs.every((run) => typeof run.finalPostconditionEvidence === 'string' && run.finalPostconditionEvidence.length > 0)).toBe(true);
  });

  test('result envelope keeps local corpus diagnostic and includes contracts plus evidence', () => {
    const envelope = buildRealWorldTaskCompletionResult();
    const result = envelope.results[0];
    expect(result.measurementMode).toBe('deterministic-fixture');
    expect(result.claimEligibility.eligible).toBe(false);
    expect(result.tasks).toHaveLength(realWorldTaskSpecs.length);
    expect(result.runs).toHaveLength(realWorldTaskSpecs.length);
    expect(result.finalPostconditionEvaluated).toBe(true);
    expect(result.finalPostconditionEvidence).toContain('rw-001-checkout-update-address');
  });
});
