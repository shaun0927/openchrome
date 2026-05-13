/// <reference types="jest" />

import { ActivityTracker, setActivityTracker } from '../../src/dashboard/activity-tracker';
import { MCPServer } from '../../src/mcp-server';
import { buildProgressStatus } from '../../src/progress/progress-status';
import { registerOcProgressStatusTool } from '../../src/tools/oc-progress-status';

function seed(calls: Array<{ tool: string; result?: 'success' | 'error'; args?: Record<string, unknown>; error?: string }>): ActivityTracker {
  const tracker = new ActivityTracker();
  for (const call of [...calls].reverse()) {
    const id = tracker.startCall(call.tool, 'test', call.args);
    tracker.endCall(id, call.result || 'success', call.error);
  }
  return tracker;
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('oc_progress_status', () => {
  test('classifies progressing baseline', () => {
    const tracker = seed([{ tool: 'navigate' }, { tool: 'interact' }]);
    const result = buildProgressStatus({ sessionId: 'test', calls: tracker.getRecentCalls(10, 'test'), window: 10 });
    expect(result.status).toBe('progressing');
    expect(result.suggestedPolicy).toBe('continue');
  });

  test('classifies stalling on observation-only calls', () => {
    const tracker = seed([{ tool: 'read_page' }, { tool: 'tabs_context' }, { tool: 'computer', args: { action: 'screenshot' } }]);
    const result = buildProgressStatus({ sessionId: 'test', calls: tracker.getRecentCalls(10, 'test'), window: 10 });
    expect(result.status).toBe('stalling');
    expect(result.counters.consecutiveNonProgress).toBe(3);
    expect(result.suggestedPolicy).toBe('refresh_state');
  });

  test('classifies stuck on repeated errors', () => {
    const tracker = seed([
      { tool: 'interact', result: 'error', error: 'stale ref' },
      { tool: 'interact', result: 'error', error: 'stale ref' },
      { tool: 'interact', result: 'error', error: 'stale ref' },
    ]);
    const result = buildProgressStatus({ sessionId: 'test', calls: tracker.getRecentCalls(10, 'test'), window: 10 });
    expect(result.status).toBe('stuck');
    expect(result.counters.consecutiveErrors).toBe(3);
    expect(result.suggestedPolicy).toBe('checkpoint_and_recover');
  });

  test('detects coordinate-click stall and switches strategy', () => {
    const tracker = seed([
      { tool: 'computer', args: { action: 'left_click', x: 1, y: 1 } },
      { tool: 'computer', args: { action: 'left_click', x: 1, y: 1 } },
      { tool: 'computer', args: { action: 'left_click', x: 1, y: 1 } },
    ]);
    const result = buildProgressStatus({ sessionId: 'test', calls: tracker.getRecentCalls(10, 'test'), window: 10 });
    expect(result.counters.coordinateClickStreak).toBe(3);
    expect(result.suggestedPolicy).toBe('switch_strategy');
    expect(result.topSignal?.rule).toBe('coordinate-click-stall');
  });

  test('detects tool oscillation', () => {
    const tracker = seed([
      { tool: 'read_page' },
      { tool: 'javascript_tool' },
      { tool: 'read_page' },
      { tool: 'javascript_tool' },
    ]);
    const result = buildProgressStatus({ sessionId: 'test', calls: tracker.getRecentCalls(10, 'test'), window: 10 });
    expect(result.counters.oscillationDetected).toBe(true);
    expect(result.suggestedPolicy).toBe('switch_strategy');
  });

  test('returns stop_episode advisory at hard non-progress threshold', () => {
    const tracker = seed(Array.from({ length: 8 }, () => ({ tool: 'read_page' })));
    const result = buildProgressStatus({ sessionId: 'test', calls: tracker.getRecentCalls(10, 'test'), window: 10 });
    expect(result.status).toBe('stuck');
    expect(result.suggestedPolicy).toBe('stop_episode');
  });

  test('redacts recent call args', async () => {
    const tracker = seed([{ tool: 'form_input', args: { password: 'super-secret-fixture-password', username: 'alice' } }]);
    setActivityTracker(tracker);
    const server = new MCPServer({} as any);
    registerOcProgressStatusTool(server);
    const handler = server.getToolHandler('oc_progress_status')!;
    const result = parse(await handler('test', { includeRecentCalls: true }));
    expect(JSON.stringify(result)).not.toContain('super-secret-fixture-password');
    expect(result.recentCalls[0].argsSummary.password).toBe('[REDACTED]');
  });

  test('wire-format invariant: content JSON equals structuredContent', async () => {
    setActivityTracker(seed([{ tool: 'navigate' }]));
    const server = new MCPServer({} as any);
    registerOcProgressStatusTool(server);
    const handler = server.getToolHandler('oc_progress_status')!;
    const result: any = await handler('test', {});
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});
