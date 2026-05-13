import { evaluateToolRiskPolicy, getEffectiveToolRiskPolicy } from '../../src/security/tool-risk-policy';

describe('tool risk policy matrix', () => {
  it('allows read-only tools without gates', () => {
    const decision = evaluateToolRiskPolicy({ tool: 'read_page' });
    expect(decision.decision).toBe('allow');
    expect(decision.policy.risk).toBe('read_only');
  });

  it('requires dry-run preview for destructive cookie deletes', () => {
    const decision = evaluateToolRiskPolicy({ tool: 'cookies', args: { action: 'delete-all' } });
    expect(decision.decision).toBe('preview_required');
    expect(decision.missing).toContain('dryRun');
  });

  it('requires elicitation after dry-run for cookie deletes', () => {
    const decision = evaluateToolRiskPolicy({ tool: 'cookies', args: { action: 'delete-all' }, dryRun: true });
    expect(decision.decision).toBe('elicitation_required');
    expect(decision.missing).toContain('elicitation');
  });

  it('requires a fresh checkpoint for irreversible form submits', () => {
    const decision = evaluateToolRiskPolicy({
      tool: 'act',
      args: { action: 'click submit payment' },
      elicitationSupported: true,
    });
    expect(decision.decision).toBe('checkpoint_required');
    expect(decision.missing).toContain('checkpoint');
  });

  it('allows irreversible form submits once prerequisites are satisfied', () => {
    const decision = evaluateToolRiskPolicy({
      tool: 'act',
      args: { action: 'click submit payment' },
      elicitationSupported: true,
      checkpoint: { createdAt: 1_000, now: 1_000 + 60_000, taskId: 'task-1' },
    });
    expect(decision.decision).toBe('allow');
  });

  it('blocks navigation outside allowed domains', () => {
    const decision = evaluateToolRiskPolicy({
      tool: 'navigate',
      args: { url: 'https://example.com' },
      allowedDomains: ['localhost'],
      elicitationSupported: true,
    });
    expect(decision.decision).toBe('blocked');
    expect(decision.missing).toContain('allowedDomain');
  });

  it('uses ToolAnnotations fallback for unknown destructive tools', () => {
    const policy = getEffectiveToolRiskPolicy('javascript_tool');
    expect(policy.risk).toBe('destructive');
    expect(policy.requiresElicitation).toBe(true);
  });
});
