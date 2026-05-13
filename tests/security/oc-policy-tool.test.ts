import { ocPolicyToolHandler } from '../../src/tools/oc-policy';

function parse(result: Awaited<ReturnType<typeof ocPolicyToolHandler>>): Record<string, unknown> {
  return JSON.parse(result.content?.[0]?.text as string) as Record<string, unknown>;
}

describe('oc_policy tool', () => {
  it('returns the documented policy matrix by default', async () => {
    const result = await ocPolicyToolHandler('sess', {});
    const body = parse(result);
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.policies)).toBe(true);
    expect(JSON.stringify(body.policies)).toContain('cookies');
  });

  it('evaluates preview-required destructive decisions in structured form', async () => {
    const result = await ocPolicyToolHandler('sess', {
      action: 'evaluate',
      tool: 'cookies',
      args: { action: 'delete-all' },
    });
    const body = parse(result) as { decision: { decision: string; missing: string[] } };
    expect(body.decision.decision).toBe('preview_required');
    expect(body.decision.missing).toContain('dryRun');
  });

  it('blocks navigation outside allowedDomains', async () => {
    const result = await ocPolicyToolHandler('sess', {
      action: 'evaluate',
      tool: 'navigate',
      args: { url: 'https://example.com' },
      allowedDomains: ['localhost'],
      elicitationSupported: true,
    });
    const body = parse(result) as { decision: { decision: string; missing: string[] } };
    expect(body.decision.decision).toBe('blocked');
    expect(body.decision.missing).toContain('allowedDomain');
  });

  it('returns validation errors without throwing', async () => {
    const result = await ocPolicyToolHandler('sess', { action: 'evaluate' });
    const body = parse(result);
    expect(result.isError).toBe(true);
    expect(body.error).toContain('tool is required');
  });
});
