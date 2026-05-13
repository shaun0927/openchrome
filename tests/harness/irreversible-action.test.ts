import { classifyBrowserActionRisk, guardIrreversibleBrowserAction } from '../../src/harness/irreversible-action';
import { resetFlagsCache } from '../../src/harness/flags';
import { registerBeforeIrreversibleHook, resetBeforeIrreversibleHookForTests } from '../../src/pilot/runtime/before-irreversible';

describe('irreversible browser action guard', () => {
  const oldEnv = process.env.OPENCHROME_PILOT;
  const oldContract = process.env.OPENCHROME_CONTRACT_RUNTIME;

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.OPENCHROME_PILOT; else process.env.OPENCHROME_PILOT = oldEnv;
    if (oldContract === undefined) delete process.env.OPENCHROME_CONTRACT_RUNTIME; else process.env.OPENCHROME_CONTRACT_RUNTIME = oldContract;
    resetFlagsCache();
    resetBeforeIrreversibleHookForTests();
  });

  it('classifies destructive click text as critical', () => {
    const risk = classifyBrowserActionRisk({ toolName: 'interact', action: 'click', labelText: 'Delete account permanently' });

    expect(risk.critical).toBe(true);
    expect(risk.evidence).toContain('delete');
  });

  it('does not classify non-mutating hover or safe cancel text as critical', () => {
    expect(classifyBrowserActionRisk({ toolName: 'interact', action: 'hover', labelText: 'Delete account' }).critical).toBe(false);
    expect(classifyBrowserActionRisk({ toolName: 'interact', action: 'click', labelText: 'Cancel delete dialog' }).critical).toBe(false);
  });

  it('matches negation tokens on word boundaries (not substring of larger words)', () => {
    const reviewAndPay = classifyBrowserActionRisk({ toolName: 'interact', action: 'click', labelText: 'Review and pay' });
    expect(reviewAndPay.critical).toBe(true);
    expect(reviewAndPay.evidence).toContain('pay');
  });

  it('treats double_click on critical text as mutating after normalization', () => {
    const risk = classifyBrowserActionRisk({ toolName: 'interact', action: 'double_click', labelText: 'Delete account permanently' });
    expect(risk.critical).toBe(true);
    expect(risk.evidence).toContain('delete');
  });

  it('passes through risky actions when pilot contract runtime is disabled', async () => {
    delete process.env.OPENCHROME_PILOT;
    resetFlagsCache();
    let ran = false;

    const result = await guardIrreversibleBrowserAction(
      { toolName: 'interact', action: 'click', labelText: 'Delete account', pageUrl: 'https://example.com/settings' },
      async () => { ran = true; return 'clicked'; },
    );

    expect(ran).toBe(true);
    expect(result.value).toBe('clicked');
    expect(result.blocked).toBeUndefined();
  });

  it('blocks critical actions when pilot hook denies', async () => {
    process.env.OPENCHROME_PILOT = '1';
    process.env.OPENCHROME_CONTRACT_RUNTIME = '1';
    resetFlagsCache();
    registerBeforeIrreversibleHook(() => ({ proceed: false, reason: 'test policy deny' }));
    let ran = false;

    const result = await guardIrreversibleBrowserAction(
      { toolName: 'interact', action: 'click', labelText: 'Submit payment', pageUrl: 'https://shop.example/checkout' },
      async () => { ran = true; return 'clicked'; },
    );

    expect(ran).toBe(false);
    expect(result.blocked?.isError).toBe(true);
    expect(result.blocked?.content?.[0].text).toContain('test policy deny');
    expect((result.blocked as any)._irreversibleAction.action).toContain('submit-payment');
  });
});
