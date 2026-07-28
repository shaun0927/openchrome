/// <reference types="jest" />

jest.mock('../src/security/audit-logger', () => {
  const actual = jest.requireActual('../src/security/audit-logger');
  return { ...actual, logAuditEntry: jest.fn() };
});

jest.mock('../src/core/task-ledger', () => {
  const actual = jest.requireActual('../src/core/task-ledger');
  return {
    ...actual,
    recordTaskToolCall: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../src/cdp/client', () => {
  const actual = jest.requireActual('../src/cdp/client');
  const client = {
    isReconnecting: jest.fn(() => false),
    setHeartbeatMode: jest.fn(),
    getConnectionMetrics: jest.fn(() => ({
      heartbeatMode: 'active',
      reconnectCount: 0,
    })),
  };
  return { ...actual, getCDPClient: jest.fn(() => client) };
});

jest.mock('../src/recording/action-recorder', () => {
  const actual = jest.requireActual('../src/recording/action-recorder');
  const recorder = {
    activeRecordingId: 'rec-accounting',
    recordActionForRecording: jest.fn().mockResolvedValue(undefined),
  };
  return {
    ...actual,
    getActiveActionRecording: jest.fn((sessionId: string) => (
      sessionId === 'accounting-session'
        ? { recorder, recordingId: recorder.activeRecordingId }
        : undefined
    )),
    __testRecorder: recorder,
  };
});

import { MCPServer, MAX_ACCOUNTING_ERROR_SUMMARY_CHARS } from '../src/mcp-server';
import type { Principal } from '../src/auth/api-key-types';
import { EMPTY_SECRET_STORE, makeSecretStore, setSecretStore } from '../src/core/secrets';
import { getActivityTracker } from '../src/dashboard/activity-tracker';
import { getDashboardState } from '../src/desktop/dashboard-state';
import { getMetricsCollector } from '../src/metrics/collector';
import { PRINCIPAL_SYM } from '../src/middleware/auth';
import { logAuditEntry } from '../src/security/audit-logger';
import { recordTaskToolCall } from '../src/core/task-ledger';
import * as taskJournal from '../src/journal/task-journal';
import { TABS_SEARCH_MAX_RESPONSE_BYTES } from '../src/config/defaults';

describe('MCPServer returned-error accounting', () => {
  let server: MCPServer | undefined;
  let journal: {
    init: jest.Mock;
    createEntry: jest.Mock;
    record: jest.Mock;
  };

  function principal(tenantId: string, scopes: Principal['scopes']): Principal {
    return { tenantId, scopes, mode: 'api-key', keyId: `key-${tenantId}` };
  }

  async function callTool(
    toolName: string,
    sessionId: string,
    caller: Principal,
    id = 1,
    args: Record<string, unknown> = {},
  ) {
    const message: Record<PropertyKey, unknown> = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: { ...args, sessionId },
      },
    };
    message[PRINCIPAL_SYM] = caller;
    return server!.handleMessage(message as Record<string, unknown>);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    journal = {
      init: jest.fn().mockResolvedValue(undefined),
      createEntry: jest.fn((
        tool: string,
        sessionId: string,
        args: Record<string, unknown>,
        durationMs: number,
        ok: boolean,
        resultSummary?: string,
      ) => ({ tool, sessionId, args, durationMs, ok, resultSummary })),
      record: jest.fn(),
    };
    jest.spyOn(taskJournal, 'getTaskJournal').mockReturnValue(journal as any);
  });

  afterEach(async () => {
    await (server as any)?._stopInternal?.();
    server = undefined;
    setSecretStore(EMPTY_SECRET_STORE);
    jest.restoreAllMocks();
  });

  test('records isError results consistently across observability surfaces', async () => {
    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'accounting-session' }),
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 0 })),
      sessionCount: 0,
    } as any);
    const toolName = `returned_error_accounting_${Date.now()}`;
    server.registerTool(
      toolName,
      jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'invalid query' }],
        isError: true,
      }),
      {
        name: toolName,
        description: 'returned error accounting test',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    );

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: {}, sessionId: 'accounting-session' },
    } as any);

    expect((response as any).result?.isError).toBe(true);
    expect(logAuditEntry).toHaveBeenCalledWith(
      toolName,
      'accounting-session',
      {},
      undefined,
      expect.objectContaining({
        status: 'error',
        errorMessage: 'invalid query',
        billable: false,
      }),
    );

    const activity = getActivityTracker().getRecentCalls(20, 'accounting-session')
      .find((call) => call.toolName === toolName);
    expect(activity).toMatchObject({ result: 'error', error: 'invalid query' });

    const dashboardRows = getDashboardState().getToolCallTotals()
      .filter((row) => row.toolName === toolName);
    expect(dashboardRows).toEqual([
      expect.objectContaining({ result: 'error', count: 1 }),
    ]);

    const metrics = getMetricsCollector().export();
    expect(metrics).toContain(
      `openchrome_tool_calls_total{tool="${toolName}",status="error",tenant="unknown"} 1`,
    );
    expect(metrics).not.toContain(
      `openchrome_tool_calls_total{tool="${toolName}",status="success",tenant="unknown"}`,
    );

    const recorder = (jest.requireMock('../src/recording/action-recorder') as {
      __testRecorder: { recordActionForRecording: jest.Mock };
    }).__testRecorder;
    expect(recorder.recordActionForRecording).toHaveBeenCalledWith(
      'rec-accounting',
      toolName,
      {},
      expect.any(Number),
      false,
      expect.objectContaining({ error: 'invalid query' }),
    );
    expect(journal.createEntry).toHaveBeenCalledWith(
      toolName,
      'accounting-session',
      {},
      expect.any(Number),
      false,
      'invalid query',
    );
  });

  test('bounds and redacts returned error summaries before persistence', async () => {
    const loadedSecret = 'loaded-secret-value-with-unique-suffix';
    setSecretStore(makeSecretStore(new Map([['TEST_TOKEN', loadedSecret]])));
    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'accounting-session' }),
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 0 })),
      sessionCount: 0,
    } as any);
    const toolName = `returned_error_redaction_${Date.now()}`;
    const rawError = [
      `request failed token=token-value password=hunter2 Authorization: Bearer bearer-secret ${loadedSecret}`,
      'x'.repeat(MAX_ACCOUNTING_ERROR_SUMMARY_CHARS * 4),
    ].join(' ');
    server.registerTool(
      toolName,
      jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: rawError }],
        isError: true,
      }),
      {
        name: toolName,
        description: 'returned error redaction test',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    );

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: {}, sessionId: 'accounting-session' },
    } as any);

    const auditMeta = (logAuditEntry as jest.Mock).mock.calls.at(-1)?.[4];
    const persistedSummary = auditMeta?.errorMessage as string;
    expect(persistedSummary.length).toBeLessThanOrEqual(MAX_ACCOUNTING_ERROR_SUMMARY_CHARS);
    expect(persistedSummary).toContain('token=[REDACTED]');
    expect(persistedSummary).toContain('password=[REDACTED]');
    expect(persistedSummary).toContain('Bearer [REDACTED]');
    expect(persistedSummary).toContain('${SECRET:TEST_TOKEN}');
    expect(persistedSummary).not.toContain('token-value');
    expect(persistedSummary).not.toContain('hunter2');
    expect(persistedSummary).not.toContain('bearer-secret');
    expect(persistedSummary).not.toContain(loadedSecret);

    const activity = getActivityTracker().getRecentCalls(20, 'accounting-session')
      .find((call) => call.toolName === toolName);
    expect(activity?.error).toBe(persistedSummary);

    const recorder = (jest.requireMock('../src/recording/action-recorder') as {
      __testRecorder: { recordActionForRecording: jest.Mock };
    }).__testRecorder;
    expect(recorder.recordActionForRecording).toHaveBeenCalledWith(
      'rec-accounting',
      toolName,
      {},
      expect.any(Number),
      false,
      expect.objectContaining({ error: persistedSummary }),
    );
    expect(journal.createEntry).toHaveBeenCalledWith(
      toolName,
      'accounting-session',
      {},
      expect.any(Number),
      false,
      persistedSummary,
    );
  });

  test('drops optional tabs_search metadata before sacrificing a successful result', async () => {
    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'accounting-session' }),
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 1 })),
      sessionCount: 1,
    } as any);
    const structured = { query: 'needle', results: [{ snippet: 'x'.repeat(8_000) }] };
    const rawResult = {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    };
    expect(Buffer.byteLength(JSON.stringify(rawResult), 'utf8'))
      .toBeLessThan(TABS_SEARCH_MAX_RESPONSE_BYTES);
    (server as any).hintEngine = {
      getHint: jest.fn(() => ({
        severity: 'info',
        rule: 'wire-cap-test',
        fireCount: 1,
        rawHint: 'h'.repeat(20_000),
        hint: 'h'.repeat(20_000),
      })),
    };
    server.registerTool(
      'tabs_search',
      jest.fn().mockResolvedValue(rawResult),
      {
        name: 'tabs_search',
        description: 'wire cap accounting test',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    );

    const metricLine = 'openchrome_tool_output_bytes_sum{tool="tabs_search",tenant="unknown"}';
    const metricValue = (dump: string): number => {
      const line = dump.split('\n').find((entry) => entry.startsWith(metricLine));
      return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
    };
    const beforeBytes = metricValue(getMetricsCollector().export());
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'tabs_search', arguments: {}, sessionId: 'accounting-session' },
    } as any);
    const result = (response as any).result;
    const framedBytes = Buffer.byteLength(`data: ${JSON.stringify(response)}\n\n`, 'utf8');

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(structured);
    expect(result._hint).toBeUndefined();
    expect(result._hintMeta).toBeUndefined();
    expect(result._automation).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(framedBytes).toBeLessThanOrEqual(TABS_SEARCH_MAX_RESPONSE_BYTES);
    expect(logAuditEntry).toHaveBeenCalledWith(
      'tabs_search',
      'accounting-session',
      {},
      undefined,
      expect.objectContaining({
        status: 'success',
        billable: true,
      }),
    );
    expect(getDashboardState().getToolCallTotals()).toContainEqual(
      expect.objectContaining({ toolName: 'tabs_search', result: 'success', count: 1 }),
    );
    expect(recordTaskToolCall).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ tool: 'tabs_search', ok: true }),
    );
    const afterBytes = metricValue(getMetricsCollector().export());
    expect(afterBytes - beforeBytes).toBe(framedBytes);
  });

  test('accounts an irreducibly oversized tabs_search result as an error', async () => {
    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'accounting-session' }),
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 1 })),
      sessionCount: 1,
    } as any);
    const structured = { query: 'needle', results: [{ snippet: 'x'.repeat(40_000) }] };
    server.registerTool(
      'tabs_search',
      jest.fn().mockResolvedValue({
        content: [
          { type: 'text', text: JSON.stringify(structured) },
          { type: 'text', text: 'Search follow-up for private acquisition' },
        ],
        structuredContent: structured,
        _hint: 'Refine private acquisition if needed',
      }),
      {
        name: 'tabs_search',
        description: 'irreducible wire cap accounting test',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    );

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'tabs_search', arguments: {}, sessionId: 'accounting-session' },
    } as any);
    const result = (response as any).result;

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('transport response exceeds');
    expect(Buffer.byteLength(`data: ${JSON.stringify(response)}\n\n`, 'utf8'))
      .toBeLessThanOrEqual(TABS_SEARCH_MAX_RESPONSE_BYTES);
    expect(logAuditEntry).toHaveBeenCalledWith(
      'tabs_search',
      'accounting-session',
      {},
      undefined,
      expect.objectContaining({
        status: 'error',
        billable: false,
        errorMessage: expect.stringContaining('transport response exceeds'),
      }),
    );
  });

  test('records scope denials before session initialization or handler dispatch', async () => {
    const getOrCreateSession = jest.fn().mockResolvedValue({ id: 'scope-session' });
    server = new MCPServer({
      getOrCreateSession,
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 0 })),
      sessionCount: 0,
    } as any);
    const toolName = `preflight_scope_accounting_${Date.now()}`;
    const handler = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    server.registerTool(toolName, handler, {
      name: toolName,
      description: 'preflight scope accounting test',
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });

    const response = await callTool(toolName, 'scope-session', principal('reader', ['read']));
    const result = (response as any).result;
    const message = `Forbidden: tool '${toolName}' requires scope 'write'.`;

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(message);
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(logAuditEntry).toHaveBeenCalledWith(
      toolName,
      'scope-session',
      { sessionId: 'scope-session' },
      undefined,
      expect.objectContaining({
        tenantId: 'reader',
        status: 'error',
        errorMessage: message,
        billable: false,
      }),
    );

    const activity = getActivityTracker().getRecentCalls(20, 'scope-session')
      .find((call) => call.toolName === toolName);
    expect(activity).toMatchObject({ result: 'error', error: message });
    expect(getDashboardState().getToolCallTotals()).toContainEqual(
      expect.objectContaining({ toolName, result: 'error', count: 1 }),
    );
    expect(getMetricsCollector().export()).toContain(
      `openchrome_tool_calls_total{tool="${toolName}",status="error",tenant="unknown"} 1`,
    );
    expect(journal.createEntry).toHaveBeenCalledWith(
      toolName,
      'scope-session',
      { sessionId: 'scope-session' },
      expect.any(Number),
      false,
      message,
    );
    expect(journal.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(recordTaskToolCall).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({
        tool: toolName,
        sessionId: 'scope-session',
        tenantId: 'reader',
        ok: false,
      }),
    );
  });

  test.each([
    {
      toolName: 'form_input',
      args: { selector: '#password', value: 'hunter2' },
    },
    {
      toolName: 'fill_form',
      args: {
        fields: {
          password: 'hunter2',
          email: 'public@example.com',
        },
        refs: { ref_12: 'one-time-code' },
      },
    },
  ])('deep-redacts denied $toolName args using the real input shape', async ({ toolName, args }) => {
    const sessionId = `redaction-${toolName}`;
    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: sessionId }),
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 0 })),
      sessionCount: 0,
    } as any);
    server.registerTool(toolName, jest.fn(), {
      name: toolName,
      description: 'preflight redaction test',
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });

    await callTool(toolName, sessionId, principal('reader', ['read']), 1, args);

    const activity = getActivityTracker().getRecentCalls(20, sessionId)
      .find((call) => call.toolName === toolName);
    expect(JSON.stringify(activity?.args)).not.toContain('hunter2');
    const dashboard = getDashboardState().getToolCalls(sessionId)
      .find((call) => call.toolName === toolName);
    expect(dashboard?.args).not.toContain('hunter2');

    const persistedJournalArgs = journal.createEntry.mock.calls.at(-1)?.[2];
    expect(JSON.stringify(persistedJournalArgs)).not.toContain('hunter2');
    const persistedTaskArgs = (recordTaskToolCall as jest.Mock).mock.calls.at(-1)?.[2]?.args;
    expect(JSON.stringify(persistedTaskArgs)).not.toContain('hunter2');

    if (toolName === 'form_input') {
      expect(persistedJournalArgs.value).toBe('[REDACTED]');
    } else {
      expect(persistedJournalArgs.fields).toEqual({
        password: '[REDACTED]',
        email: '[REDACTED]',
      });
      expect(persistedJournalArgs.refs).toEqual({ ref_12: '[REDACTED]' });
      expect(JSON.stringify(persistedJournalArgs)).not.toContain('public@example.com');
      expect(JSON.stringify(persistedJournalArgs)).not.toContain('one-time-code');
    }
  });

  test('hashes tabs_search queries across persistence telemetry', async () => {
    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'query-redaction-session' }),
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 0 })),
      sessionCount: 0,
    } as any);
    const structured = {
      sessionId: 'query-redaction-session',
      query: 'private acquisition',
      results: [],
      errors: [],
    };
    server.registerTool(
      'tabs_search',
      jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
      }),
      {
        name: 'tabs_search',
        description: 'query telemetry redaction test',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    );

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'tabs_search',
        arguments: { sessionId: 'query-redaction-session', query: 'private acquisition' },
      },
    } as any);

    const activity = getActivityTracker().getRecentCalls(20, 'query-redaction-session')
      .find((call) => call.toolName === 'tabs_search');
    expect(activity?.args?.query).toMatch(/^sha256:/);
    expect(JSON.stringify(activity?.args)).not.toContain('private acquisition');
    const persistedTaskArgs = (recordTaskToolCall as jest.Mock).mock.calls.at(-1)?.[2]?.args;
    expect(persistedTaskArgs.query).toMatch(/^sha256:/);
    expect((response.result?.content?.[0]?.text ?? '')).toContain('private acquisition');

    const recoveryNode = (server as any).recoveryLedger
      .getLastNode('query-redaction-session');
    expect(recoveryNode.observationSummary).toContain('sha256:');
    expect(recoveryNode.observationSummary).not.toContain('private acquisition');
  });

  test('records cross-tenant session denials without dispatching the denied call', async () => {
    const getOrCreateSession = jest.fn().mockResolvedValue({ id: 'tenant-session' });
    server = new MCPServer({
      getOrCreateSession,
      addEventListener: jest.fn(),
      cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn(() => ({ totalTargets: 0 })),
      sessionCount: 0,
    } as any);
    const toolName = `preflight_tenant_accounting_${Date.now()}`;
    const handler = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    server.registerTool(toolName, handler, {
      name: toolName,
      description: 'preflight tenant accounting test',
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });

    await callTool(toolName, 'tenant-session', principal('alice', ['read', 'write']));
    jest.clearAllMocks();

    const response = await callTool(
      toolName,
      'tenant-session',
      principal('bob', ['read', 'write']),
      2,
    );
    const result = (response as any).result;
    const message = "Forbidden: session 'tenant-session' is owned by another tenant.";

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(message);
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(logAuditEntry).toHaveBeenCalledWith(
      toolName,
      'tenant-session',
      { sessionId: 'tenant-session' },
      undefined,
      expect.objectContaining({
        tenantId: 'bob',
        status: 'error',
        errorMessage: message,
        billable: false,
      }),
    );
    expect(journal.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(recordTaskToolCall).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ tenantId: 'bob', ok: false }),
    );
  });
});
