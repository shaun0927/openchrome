import { PlanExecutor } from '../../src/orchestration/plan-executor';
import type { CompiledPlan } from '../../src/types/plan-cache';
import type { MCPResult, ToolHandler } from '../../src/types/mcp';

const text = (value: string, isError = false): MCPResult => ({ content: [{ type: 'text', text: value }], isError });

function plan(): CompiledPlan {
  return {
    id: 'test-plan',
    version: '1',
    description: 'test',
    parameters: {},
    steps: [
      { order: 1, tool: 'interact', args: { ref: 'old', tabId: '${tabId}' }, timeout: 1000 },
      { order: 2, tool: 'read_page', args: { tabId: '${tabId}' }, timeout: 1000, parseResult: { format: 'text', storeAs: 'page' } },
    ],
    errorHandlers: [],
    successCriteria: { requiredFields: ['page'] },
  };
}

describe('PlanExecutor bounded recovery', () => {
  it('is disabled by default and preserves original failure', async () => {
    const handlers = new Map<string, ToolHandler>([
      ['interact', async () => text('ref is stale', true)],
      ['read_page', async () => text('fresh page')],
    ]);
    const executor = new PlanExecutor((name) => handlers.get(name) ?? null);

    const result = await executor.execute(plan(), 's1', { tabId: 'tab-1' });

    expect(result.success).toBe(false);
    expect(result.recovery).toBeUndefined();
  });

  it('tries bounded read-only recovery but does not skip retrying the failed step', async () => {
    const calls: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      ['interact', async () => { calls.push('interact'); return text('ref is stale', true); }],
      ['read_page', async () => { calls.push('read_page'); return text('fresh page with refs'); }],
    ]);
    const executor = new PlanExecutor((name) => handlers.get(name) ?? null);

    const result = await executor.execute(plan(), 's1', { tabId: 'tab-1' }, {
      boundedRecovery: { enabled: true, maxCandidates: 2, maxToolCalls: 1, perCandidateTimeoutMs: 1000 },
    });

    expect(result.success).toBe(false);
    expect(calls).toEqual(['interact', 'read_page']);
    expect(result.error).toContain('ref is stale');
    expect(result.recovery?.attempts[0]).toMatchObject({ tool: 'read_page', status: 'success' });
  });

  it('blocks side-effect candidates and enforces max tool-call budget', async () => {
    const handlers = new Map<string, ToolHandler>([
      ['click', async () => text('CAPTCHA Access Denied Login page detected', true)],
      ['read_page', async () => text('', false)],
      ['tabs_context', async () => text('tab state')],
    ]);
    const captchaPlan = plan();
    captchaPlan.steps[0] = { order: 1, tool: 'click', args: { tabId: '${tabId}' }, timeout: 1000 };
    const executor = new PlanExecutor((name) => handlers.get(name) ?? null);

    const result = await executor.execute(captchaPlan, 's1', { tabId: 'tab-1' }, {
      boundedRecovery: { enabled: true, maxCandidates: 3, maxToolCalls: 1, perCandidateTimeoutMs: 1000 },
    });

    expect(result.success).toBe(false);
    expect(result.recovery?.attempts.length).toBe(1);
    expect(result.recovery?.exhausted).toBe(true);
    expect(result.recovery?.attempts[0].tool).toBe('read_page');
  });
  it('lets success criteria judge empty results when no empty-result recovery exists', async () => {
    const handlers = new Map<string, ToolHandler>([
      ['read_page', async () => text('')],
    ]);
    const emptyPlan = plan();
    emptyPlan.steps = [
      { order: 1, tool: 'read_page', args: { tabId: '${tabId}' }, timeout: 1000, parseResult: { format: 'text', storeAs: 'page' } },
    ];
    emptyPlan.successCriteria = { requiredFields: ['page'] };
    const executor = new PlanExecutor((name) => handlers.get(name) ?? null);

    const result = await executor.execute(emptyPlan, 's1', { tabId: 'tab-1' }, {
      boundedRecovery: { enabled: true, maxCandidates: 2, maxToolCalls: 1, perCandidateTimeoutMs: 1000 },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ page: '' });
    expect(result.recovery?.attempts.every((attempt) => attempt.status !== 'success')).toBe(true);
  });

});
