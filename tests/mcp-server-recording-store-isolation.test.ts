/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCPServer } from '../src/mcp-server';
import {
  ActionRecorder,
  registerSessionRecorder,
  unregisterSessionRecorder,
} from '../src/recording/action-recorder';
import { RecordingStore } from '../src/recording/recording-store';
import type { MCPRequest, MCPToolDefinition } from '../src/types/mcp';

const TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function toolDefinition(name: string): MCPToolDefinition {
  return {
    name,
    description: `${name} integration test tool`,
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

async function waitForActionCount(
  store: RecordingStore,
  recordingId: string,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (store.readActions(recordingId).length === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} action(s) in ${recordingId}`);
}

describe('MCPServer real recording-store session isolation', () => {
  let dirA: string;
  let dirB: string;
  let storeA: RecordingStore;
  let storeB: RecordingStore;
  let recorderA: ActionRecorder;
  let recorderB: ActionRecorder;
  let recordingA: string;
  let recordingB: string;
  let server: MCPServer;

  beforeEach(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcp-recording-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mcp-recording-b-'));
    storeA = new RecordingStore(dirA);
    storeB = new RecordingStore(dirB);
    recorderA = new ActionRecorder(storeA, { captureScreenshots: false });
    recorderB = new ActionRecorder(storeB, { captureScreenshots: false });
    recordingA = (await recorderA.start('session-a')).id;
    recordingB = (await recorderB.start('session-b')).id;
    registerSessionRecorder('session-a', recorderA);
    registerSessionRecorder('session-b', recorderB);

    server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 'session' }),
      addEventListener: jest.fn(),
      getAllSessionInfos: jest.fn().mockReturnValue([]),
      sessionCount: 0,
    } as any);
  });

  afterEach(async () => {
    if (recorderA.isRecording) await recorderA.stop();
    if (recorderB.isRecording) await recorderB.stop();
    unregisterSessionRecorder('session-a');
    unregisterSessionRecorder('session-b');
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('writes each result only to the recording active for that tool session', async () => {
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

    await Promise.all([
      callTool(server, 'record_ok', 'session-a'),
      callTool(server, 'record_soft_error', 'session-b'),
    ]);
    await Promise.all([
      waitForActionCount(storeA, recordingA, 1),
      waitForActionCount(storeB, recordingB, 1),
    ]);

    expect(storeA.readActions(recordingA)).toEqual([
      expect.objectContaining({ tool: 'record_ok', ok: true }),
    ]);
    expect(storeB.readActions(recordingB)).toEqual([
      expect.objectContaining({ tool: 'record_soft_error', ok: false }),
    ]);

    await callTool(server, 'record_ok', 'session-c');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(storeA.readActions(recordingA)).toHaveLength(1);
    expect(storeB.readActions(recordingB)).toHaveLength(1);
  });
});
