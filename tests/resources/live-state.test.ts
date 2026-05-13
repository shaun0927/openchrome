import {
  LIVE_RESOURCE_TEMPLATES,
  parseLiveResourceUri,
  parseResourceSubscriptionLimit,
  ResourceRpcError,
  assertLiveResourceAccess,
  readLiveResource,
  RESOURCE_FORBIDDEN_CODE,
} from '../../src/resources/live-state';

jest.mock('../../src/journal/task-journal', () => ({
  getTaskJournal: () => ({
    getRecent: () => [
      { ts: 1, tool: 'navigate', sessionId: 'missing-session', args: {}, durationMs: 1, ok: true, summary: 'hidden' },
      { ts: 2, tool: 'read_page', sessionId: 'owned-session', args: {}, durationMs: 1, ok: true, summary: 'visible' },
    ],
  }),
}));

describe('live MCP resources (#872)', () => {
  test('advertises the five live URI templates', () => {
    expect(LIVE_RESOURCE_TEMPLATES.map((t) => t.uriTemplate)).toEqual([
      'oc://session/{sessionId}/tabs',
      'oc://session/{sessionId}/state',
      'oc://journal/{taskId}',
      'oc://recording/{recordingId}',
      'oc://dashboard/state',
    ]);
  });

  test('parses concrete live resource URIs', () => {
    expect(parseLiveResourceUri('oc://session/main/tabs')).toEqual({ kind: 'session-tabs', id: 'main' });
    expect(parseLiveResourceUri('oc://session/main/state')).toEqual({ kind: 'session-state', id: 'main' });
    expect(parseLiveResourceUri('oc://journal/task-1')).toEqual({ kind: 'journal', id: 'task-1' });
    expect(parseLiveResourceUri('oc://recording/rec-1')).toEqual({ kind: 'recording', id: 'rec-1' });
    expect(parseLiveResourceUri('oc://dashboard/state')).toEqual({ kind: 'dashboard-state' });
  });

  test('enforces same-tenant access for session resources', () => {
    const sessionManager = {
      getSession: (id: string) => ({ id, tenantId: 'tenant-b' }),
    } as any;

    expect(() => assertLiveResourceAccess(sessionManager, 'oc://session/s1/tabs', 'tenant-a')).toThrow(ResourceRpcError);
    try {
      assertLiveResourceAccess(sessionManager, 'oc://session/s1/tabs', 'tenant-a');
    } catch (err) {
      expect((err as ResourceRpcError).code).toBe(RESOURCE_FORBIDDEN_CODE);
    }
  });

  test('does not expose journal entries after the owner session is gone', async () => {
    const sessionManager = {
      getSession: (id: string) => (id === 'owned-session' ? { id, tenantId: 'default' } : undefined),
    } as any;

    await expect(readLiveResource(sessionManager, 'oc://journal/owned-session')).resolves.toMatchObject({
      mimeType: 'application/json',
      text: expect.stringContaining('visible'),
    });
    await expect(readLiveResource(sessionManager, 'oc://journal/missing-session')).resolves.toEqual({
      mimeType: 'application/json',
      text: JSON.stringify({ taskId: 'missing-session', entries: [], count: 0 }),
    });
  });

  test('bounds subscription limit env parsing', () => {
    expect(parseResourceSubscriptionLimit(undefined)).toBe(50);
    expect(parseResourceSubscriptionLimit('0')).toBe(50);
    expect(parseResourceSubscriptionLimit('2')).toBe(2);
    expect(parseResourceSubscriptionLimit('5000')).toBe(1000);
  });
});
