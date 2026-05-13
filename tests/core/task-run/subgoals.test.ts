import {
  buildConservativeSubgoalPlan,
  evaluateSubgoalStop,
  shouldDecomposeTask,
  validateSubgoalPlan,
} from '../../../src/core/task-run';

describe('bounded subgoal decomposition', () => {
  test('is opt-in and bypasses simple tasks by default', () => {
    expect(shouldDecomposeTask({ objective: 'click login', optIn: false })).toBe(false);
    expect(shouldDecomposeTask({ objective: 'click login', optIn: true })).toBe(false);
    expect(shouldDecomposeTask({ objective: 'find the latest report and download it from the local site', optIn: true })).toBe(true);
    expect(shouldDecomposeTask({ objective: 'click login', optIn: true, force: true })).toBe(true);
  });

  test('builds conservative bounded subgoals with required global stop conditions', () => {
    const plan = buildConservativeSubgoalPlan({ objective: 'find latest report', allowedDomains: ['localhost'] });
    expect(plan.subgoals).toHaveLength(3);
    expect(plan.global_stop_conditions.join(' ')).toContain('captcha');
    expect(plan.global_stop_conditions.join(' ')).toContain('destructive');
    expect(validateSubgoalPlan(plan, { allowedDomains: ['localhost'] }).ok).toBe(true);
  });

  test('schema rejects missing success criteria and stop conditions', () => {
    const result = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: ['auth', 'captcha', 'destructive'],
      subgoals: [{ id: 'bad', goal: 'do thing', allowed_tools: ['read_page'] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('success_criteria');
      expect(result.errors.join('\n')).toContain('stop_condition');
    }
  });

  test('rejects out-of-domain subgoals and unsafe destructive goals without policy stop', () => {
    const result = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: ['auth handoff required', 'captcha or bot check', 'destructive confirmation required'],
      subgoals: [{
        id: 'pay-now',
        goal: 'click purchase button',
        success_criteria: 'order is placed',
        allowed_tools: ['interact'],
        stop_condition: 'button clicked',
        allowed_domains: ['evil.test'],
      }],
    }, { allowedDomains: ['localhost'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('destructive-looking');
      expect(result.errors.join('\n')).toContain('outside allowed scope');
    }
  });

  test('stop-condition handling halts on auth, captcha, and destructive confirmation', () => {
    const subgoal = buildConservativeSubgoalPlan({ objective: 'x' }).subgoals[0];
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'Login required' })).toMatchObject({ status: 'stopped', next_safe_action: 'ask_user' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'captcha challenge' })).toMatchObject({ status: 'stopped', next_safe_action: 'ask_user' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'Confirm purchase' })).toMatchObject({ status: 'stopped', next_safe_action: 'request_policy_confirmation' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'dashboard visible', passed: true })).toMatchObject({ status: 'passed' });
  });
});
