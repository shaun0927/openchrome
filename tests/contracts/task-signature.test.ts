/// <reference types="jest" />

import {
  evaluateTaskSignature,
  preflightAllowedTools,
  redactTaskSignatureInputs,
  validateBrowserTaskSignature,
  type BrowserTaskSignature,
} from '../../src/contracts/task-signature';

function validSignature(overrides: Partial<BrowserTaskSignature> = {}): BrowserTaskSignature {
  return {
    version: 1,
    id: 'fixture.search.success',
    description: 'Search form reaches result state',
    inputs: {
      query: { type: 'string', required: true, redaction: 'none' },
      password: { type: 'string', required: false, redaction: 'secret' },
    },
    allowedTools: ['navigate', 'find', 'interact', 'read_page'],
    success: { kind: 'dom_text', selector: '#result', contains: 'Searched: cats' },
    loopGuards: [{ kind: 'max_observation_calls', limit: 2, window: 4 }],
    budgets: { maxToolCalls: 8, maxWallMs: 30_000 },
    ...overrides,
  };
}

describe('BrowserTaskSignature validation', () => {
  it('accepts a deterministic task signature', () => {
    const result = validateBrowserTaskSignature(validSignature());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.success.kind).toBe('dom_text');
  });

  it('returns batched errors for invalid schema and nested assertions', () => {
    const result = validateBrowserTaskSignature({
      version: 2,
      id: '',
      description: 'bad',
      inputs: { 'not-valid-name!': { type: 'text', required: 'yes' } },
      allowedTools: [],
      success: { kind: 'unknown_contract' },
      loopGuards: [{ kind: 'max_same_tool', limit: 3, window: 2 }],
      budgets: { maxToolCalls: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toEqual(expect.arrayContaining([
        '$.version', '$.id', '$.inputs.not-valid-name!', '$.allowedTools',
        '$.success.kind', '$.loopGuards.0.limit', '$.budgets.maxToolCalls',
      ]));
    }
  });

  it('redacts secret inputs without mutating non-secret values', () => {
    expect(redactTaskSignatureInputs(validSignature(), {
      query: 'cats', password: 'super-secret-fixture-password', extra: 'kept',
    })).toEqual({ query: 'cats', password: '[REDACTED]', extra: 'kept' });
  });
});

describe('BrowserTaskSignature evaluator', () => {
  it('detects success assertion pass', async () => {
    await expect(evaluateTaskSignature({
      signature: validSignature(), recentTools: [], elapsedMs: 100, toolCount: 1,
      assertionEvaluator: async () => ({ passed: true, evidence: { passed: true, assertion_kind: 'dom_text', details: {} } }),
    })).resolves.toMatchObject({ status: 'success' });
  });

  it('detects failure assertions before success', async () => {
    await expect(evaluateTaskSignature({
      signature: validSignature({ failureWhen: [{ kind: 'url', pattern: 'logout' }] }),
      recentTools: [], elapsedMs: 100, toolCount: 1,
      assertionEvaluator: async (assertion) => ({ passed: assertion.kind === 'url', evidence: { passed: assertion.kind === 'url', assertion_kind: assertion.kind, details: {} } }),
    })).resolves.toEqual({ status: 'failure', reasons: ["failureWhen assertion 'url' passed"] });
  });

  it('detects explicit stop conditions', async () => {
    await expect(evaluateTaskSignature({
      signature: validSignature({ stopWhen: [{ kind: 'dom_text', contains: 'Done' }] }),
      recentTools: [], elapsedMs: 100, toolCount: 1,
      assertionEvaluator: async (assertion) => ({ passed: assertion.kind === 'dom_text', evidence: { passed: assertion.kind === 'dom_text', assertion_kind: assertion.kind, details: {} } }),
    })).resolves.toEqual({ status: 'stop', reasons: ["stopWhen assertion 'dom_text' passed"] });
  });

  it('detects budget exhaustion and loop guard violations deterministically', async () => {
    await expect(evaluateTaskSignature({
      signature: validSignature({ budgets: { maxToolCalls: 2, maxWallMs: 30_000 } }),
      recentTools: [{ tool: 'navigate' }, { tool: 'read_page' }], elapsedMs: 100, toolCount: 2,
    })).resolves.toMatchObject({ status: 'budget_exhausted' });

    await expect(evaluateTaskSignature({
      signature: validSignature({ loopGuards: [{ kind: 'max_non_progress_calls', limit: 2, window: 3 }] }),
      recentTools: [{ tool: 'read_page', progressed: false }, { tool: 'read_page', progressed: false }],
      elapsedMs: 100, toolCount: 2,
    })).resolves.toEqual({ status: 'stop', reasons: ['max_non_progress_calls exceeded: 2/2'] });
  });

  it('preflights disallowed tools before execution', () => {
    expect(preflightAllowedTools(validSignature(), ['navigate', 'javascript_tool'])).toEqual({
      status: 'failure',
      reasons: ['signature fixture.search.success disallows tool(s): javascript_tool'],
    });
  });
});
