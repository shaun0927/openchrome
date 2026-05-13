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


  test('malformed arrays return validation errors instead of throwing', () => {
    const malformedTopLevel = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: {},
      subgoals: 3,
    });
    expect(malformedTopLevel.ok).toBe(false);
    if (!malformedTopLevel.ok) {
      expect(malformedTopLevel.errors.join('\n')).toContain('subgoals must be a non-empty array');
      expect(malformedTopLevel.errors.join('\n')).toContain('global_stop_conditions must be an array');
    }

    const malformedSubgoal = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: ['auth handoff required', 'captcha or bot check', 'destructive confirmation required'],
      subgoals: [{
        id: 'bad-domains',
        goal: 'read site',
        success_criteria: 'content visible',
        allowed_tools: ['read_page'],
        stop_condition: 'content visible',
        allowed_domains: 'localhost',
      }],
    }, { allowedDomains: ['localhost'] });
    expect(malformedSubgoal.ok).toBe(false);
    if (!malformedSubgoal.ok) expect(malformedSubgoal.errors.join('\n')).toContain('allowed_domains must be an array');
  });


  test('decomposition keyword matching uses word boundaries', () => {
    expect(shouldDecomposeTask({ objective: 'scan candy page', optIn: true })).toBe(false);
    expect(shouldDecomposeTask({ objective: 'scan page and report result', optIn: true })).toBe(true);
  });

  test('builder clones global stops and never emits empty allowed tool lists', () => {
    const first = buildConservativeSubgoalPlan({ objective: 'x', allowedTools: ['interact'] });
    first.global_stop_conditions.push('mutated');
    const second = buildConservativeSubgoalPlan({ objective: 'x', allowedTools: ['interact'] });

    expect(second.global_stop_conditions).not.toContain('mutated');
    expect(first.subgoals.every((subgoal) => subgoal.allowed_tools.length > 0)).toBe(true);
    expect(first.subgoals[0].allowed_tools).toEqual(['interact']);
  });


  test('schema rejects non-string global stop condition entries without throwing', () => {
    const result = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: ['auth handoff required', 'captcha or bot check', 'destructive confirmation required', 42],
      subgoals: [{
        id: 'bad-global-stop',
        goal: 'read site',
        success_criteria: 'content visible',
        allowed_tools: ['read_page'],
        stop_condition: 'content visible',
      }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('global_stop_conditions must contain only strings');
  });

  test('schema rejects non-string allowed tools without throwing', () => {
    const result = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: ['auth handoff required', 'captcha or bot check', 'destructive confirmation required'],
      subgoals: [{
        id: 'bad-tools',
        goal: 'read site',
        success_criteria: 'content visible',
        allowed_tools: ['read_page', 42],
        stop_condition: 'content visible',
      }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('allowed_tools must contain only strings');
  });

  test('schema rejects non-string allowed domains without throwing', () => {
    const result = validateSubgoalPlan({
      objective: 'x',
      global_stop_conditions: ['auth handoff required', 'captcha or bot check', 'destructive confirmation required'],
      subgoals: [{
        id: 'bad-domain-item',
        goal: 'read site',
        success_criteria: 'content visible',
        allowed_tools: ['read_page'],
        stop_condition: 'content visible',
        allowed_domains: ['localhost', { host: 'evil.test' }],
      }],
    }, { allowedDomains: ['localhost'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('allowed_domains must contain only strings');
  });

  test('auth stop matcher does not treat generic required text as authentication', () => {
    const subgoal = buildConservativeSubgoalPlan({ objective: 'x' }).subgoals[0];
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'required field is missing' })).toMatchObject({ status: 'pending' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'sign in to continue' })).toMatchObject({ status: 'stopped', next_safe_action: 'ask_user' });
  });

  test('stop-condition handling halts on auth, captcha, and destructive confirmation', () => {
    const subgoal = buildConservativeSubgoalPlan({ objective: 'x' }).subgoals[0];
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'Login required' })).toMatchObject({ status: 'stopped', next_safe_action: 'ask_user' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'captcha challenge' })).toMatchObject({ status: 'stopped', next_safe_action: 'ask_user' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'Confirm purchase' })).toMatchObject({ status: 'stopped', next_safe_action: 'request_policy_confirmation' });
    expect(evaluateSubgoalStop({ subgoal, evidenceText: 'dashboard visible', passed: true })).toMatchObject({ status: 'passed' });
  });
});
