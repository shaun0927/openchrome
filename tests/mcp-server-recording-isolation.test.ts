/// <reference types="jest" />

interface FakeRecorder {
  activeRecordingId: string;
  recordActionForRecording: jest.Mock;
}

const mockRecorders = new Map<string, FakeRecorder>();
const mockGetActiveActionRecording = jest.fn((sessionId: string) => {
  const recorder = mockRecorders.get(sessionId);
  return recorder ? { recorder, recordingId: recorder.activeRecordingId } : undefined;
});
const mockBeginSessionRecorderDeletion = jest.fn((sessionId: string) => {
  mockRecorders.delete(sessionId);
});
const mockCompleteSessionRecorderDeletion = jest.fn((sessionId: string) => {
  mockRecorders.delete(sessionId);
});

jest.mock('../src/recording/action-recorder', () => ({
  beginSessionRecorderDeletion: mockBeginSessionRecorderDeletion,
  completeSessionRecorderDeletion: mockCompleteSessionRecorderDeletion,
  getActiveActionRecording: mockGetActiveActionRecording,
}));

import { MCPServer } from '../src/mcp-server';
import type { MCPRequest, MCPResult, MCPToolDefinition } from '../src/types/mcp';

const TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function toolDefinition(name: string): MCPToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
    annotations: TOOL_ANNOTATIONS,
  };
}

function callTool(server: MCPServer, name: string, sessionId: string): Promise<unknown> {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: `${name}-${sessionId}`,
    method: 'tools/call',
    params: { name, arguments: {}, sessionId },
  };
  return server.handleRequest(request);
}

async function flushRecordingWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('MCPServer session-scoped recording hooks', () => {
  let listeners: Array<(event: Record<string, unknown>) => void>;
  let server: MCPServer;

  beforeEach(() => {
    listeners = [];
    mockRecorders.clear();
    mockGetActiveActionRecording.mockClear();
    mockBeginSessionRecorderDeletion.mockClear();
    mockCompleteSessionRecorderDeletion.mockClear();

    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'session' }),
      addEventListener: jest.fn((listener) => listeners.push(listener)),
      getAllSessionInfos: jest.fn().mockReturnValue([]),
      sessionCount: 0,
    } as any);
  });

  it('routes successful and returned-error results only to the matching session recorder', async () => {
    const recordA = jest.fn().mockResolvedValue(undefined);
    const recordB = jest.fn().mockResolvedValue(undefined);
    mockRecorders.set('session-a', { activeRecordingId: 'rec-a', recordActionForRecording: recordA });
    mockRecorders.set('session-b', { activeRecordingId: 'rec-b', recordActionForRecording: recordB });

    server.registerTool(
      'record_ok',
      jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      toolDefinition('record_ok'),
    );
    server.registerTool(
      'record_soft_error',
      jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'failed' }], isError: true }),
      toolDefinition('record_soft_error'),
    );

    await callTool(server, 'record_ok', 'session-a');
    await callTool(server, 'record_ok', 'session-b');
    await callTool(server, 'record_soft_error', 'session-a');
    await flushRecordingWrites();

    expect(recordA).toHaveBeenCalledTimes(2);
    expect(recordA.mock.calls[0][0]).toBe('rec-a');
    expect(recordA.mock.calls[0][1]).toBe('record_ok');
    expect(recordA.mock.calls[0][4]).toBe(true);
    expect(recordA.mock.calls[1][0]).toBe('rec-a');
    expect(recordA.mock.calls[1][1]).toBe('record_soft_error');
    expect(recordA.mock.calls[1][4]).toBe(false);
    expect(recordB).toHaveBeenCalledTimes(1);
    expect(recordB.mock.calls[0][0]).toBe('rec-b');
    expect(recordB.mock.calls[0][1]).toBe('record_ok');
  });

  it('routes thrown failures to the matching recorder only', async () => {
    const recordB = jest.fn().mockResolvedValue(undefined);
    mockRecorders.set('session-b', { activeRecordingId: 'rec-b', recordActionForRecording: recordB });

    server.registerTool(
      'record_throw',
      jest.fn().mockRejectedValue(new Error('boom')),
      toolDefinition('record_throw'),
    );

    await callTool(server, 'record_throw', 'session-b');
    await flushRecordingWrites();

    expect(recordB).toHaveBeenCalledTimes(1);
    expect(recordB.mock.calls[0][0]).toBe('rec-b');
    expect(recordB.mock.calls[0][1]).toBe('record_throw');
    expect(recordB.mock.calls[0][4]).toBe(false);
  });

  it('does not append an inactive session call to another active session recorder', async () => {
    const recordA = jest.fn().mockResolvedValue(undefined);
    mockRecorders.set('session-a', { activeRecordingId: 'rec-a', recordActionForRecording: recordA });

    server.registerTool(
      'record_inactive',
      jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      toolDefinition('record_inactive'),
    );

    await callTool(server, 'record_inactive', 'session-b');
    await flushRecordingWrites();

    expect(recordA).not.toHaveBeenCalled();
  });

  it('does not record the recording tools themselves', async () => {
    const recordA = jest.fn().mockResolvedValue(undefined);
    mockRecorders.set('session-a', { activeRecordingId: 'rec-a', recordActionForRecording: recordA });
    server.registerTool(
      'oc_recording_status',
      jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'status' }] }),
      toolDefinition('oc_recording_status'),
    );

    await callTool(server, 'oc_recording_status', 'session-a');
    await flushRecordingWrites();

    expect(recordA).not.toHaveBeenCalled();
    expect(mockGetActiveActionRecording).not.toHaveBeenCalled();
  });

  it('keeps an in-flight call fenced to the recording active at dispatch', async () => {
    let markHandlerStarted!: () => void;
    let releaseHandler!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const recordOld = jest.fn().mockResolvedValue(undefined);
    const recordReplacement = jest.fn().mockResolvedValue(undefined);
    mockRecorders.set('session-a', { activeRecordingId: 'rec-old', recordActionForRecording: recordOld });
    server.registerTool(
      'record_slow',
      jest.fn(async (): Promise<MCPResult> => {
        markHandlerStarted();
        await handlerGate;
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
      toolDefinition('record_slow'),
    );

    const inFlight = callTool(server, 'record_slow', 'session-a');
    await handlerStarted;
    for (const listener of listeners) {
      listener({ type: 'session:deleting', sessionId: 'session-a', timestamp: Date.now() });
      listener({ type: 'session:deleted', sessionId: 'session-a', timestamp: Date.now() });
    }
    mockRecorders.set('session-a', {
      activeRecordingId: 'rec-replacement',
      recordActionForRecording: recordReplacement,
    });
    releaseHandler();

    await inFlight;
    await flushRecordingWrites();

    expect(recordOld).toHaveBeenCalledTimes(1);
    expect(recordOld.mock.calls[0][0]).toBe('rec-old');
    expect(recordReplacement).not.toHaveBeenCalled();
  });

  it('blocks recorder ownership during deletion and evicts only that session', () => {
    mockRecorders.set('session-a', { activeRecordingId: 'rec-a', recordActionForRecording: jest.fn() });
    mockRecorders.set('session-b', { activeRecordingId: 'rec-b', recordActionForRecording: jest.fn() });

    for (const listener of listeners) {
      listener({ type: 'session:deleting', sessionId: 'session-a', timestamp: Date.now() });
    }

    expect(mockBeginSessionRecorderDeletion).toHaveBeenCalledWith('session-a');
    expect(mockRecorders.has('session-a')).toBe(false);
    expect(mockRecorders.has('session-b')).toBe(true);

    for (const listener of listeners) {
      listener({ type: 'session:deleted', sessionId: 'session-a', timestamp: Date.now() });
    }

    expect(mockCompleteSessionRecorderDeletion).toHaveBeenCalledWith('session-a');
    expect(mockRecorders.has('session-a')).toBe(false);
    expect(mockRecorders.has('session-b')).toBe(true);
  });
});
