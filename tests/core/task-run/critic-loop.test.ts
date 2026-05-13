import { runBoundedCriticLoop, validateCriticVerdict } from '../../../src/core/task-run';

describe('bounded task critic loop', () => {
  test('validates critic verdict schema', () => {
    expect(validateCriticVerdict({ status: 'success', reason: 'done', evidence_used: ['banner'], missing_evidence: [], next_strategy: 'stop' }).ok).toBe(true);
    const invalid = validateCriticVerdict({ status: 'maybe' });
    expect(invalid.ok).toBe(false);
  });

  test('raw tool success is insufficient without critic success verdict', async () => {
    const result = await runBoundedCriticLoop(
      { objective: 'submit form', successCriteria: ['success banner'], maxAttempts: 1 },
      {
        executeAttempt: async () => ({ tool: 'interact', ok: true, evidence: { text: 'clicked' } }),
        critique: async () => ({ status: 'retryable_failure', reason: 'banner missing', evidence_used: ['clicked'], missing_evidence: ['success banner'], next_strategy: 'read page then retry' }),
      },
    );

    expect(result.status).toBe('max_attempts_exhausted');
    expect(result.attempts[0].ok).toBe(true);
    expect(result.finalVerdict.reason).toContain('max attempts');
  });

  test('retries retryable failures and stops on success', async () => {
    const result = await runBoundedCriticLoop(
      { objective: 'submit form', successCriteria: ['success banner'], maxAttempts: 3 },
      {
        executeAttempt: async (attempt, strategy) => ({ tool: 'act', ok: attempt === 2, evidence: { strategy } }),
        critique: async ({ attempt }) => attempt === 1
          ? { status: 'retryable_failure', reason: 'overlay blocked click', evidence_used: ['overlay'], missing_evidence: ['success banner'], next_strategy: 'dismiss overlay then submit' }
          : { status: 'success', reason: 'success banner visible', evidence_used: ['success banner'], missing_evidence: [], next_strategy: 'stop' },
      },
    );

    expect(result.status).toBe('success');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1].evidence.strategy).toBe('dismiss overlay then submit');
    expect(result.nextSafeAction).toBe('stop_success');
  });

  test('terminal failure and needs_user stop immediately', async () => {
    const terminal = await runBoundedCriticLoop(
      { objective: 'login', successCriteria: ['dashboard'], maxAttempts: 3 },
      {
        executeAttempt: async () => ({ tool: 'act', ok: false, evidence: {} }),
        critique: async () => ({ status: 'needs_user', reason: 'captcha', evidence_used: ['captcha'], missing_evidence: [], next_strategy: 'ask user' }),
      },
    );
    expect(terminal.status).toBe('needs_user');
    expect(terminal.attempts).toHaveLength(1);
    expect(terminal.nextSafeAction).toBe('ask_user');
  });

  test('malformed critic output becomes terminal failure', async () => {
    const result = await runBoundedCriticLoop(
      { objective: 'x', successCriteria: ['y'], maxAttempts: 3 },
      {
        executeAttempt: async () => ({ tool: 'act', ok: false, evidence: {} }),
        critique: async () => ({ status: 'bad' }),
      },
    );
    expect(result.status).toBe('terminal_failure');
    expect(result.finalVerdict.missing_evidence).toContain('valid_critic_verdict');
  });
});
