/// <reference types="jest" />

interface FakeRecorder {
  isRecording: boolean;
  activeRecordingId: string | null;
  activeMetadata: Record<string, unknown> | null;
  activeTrajectoryBundle: null;
  start: jest.Mock;
  stop: jest.Mock;
}

let mockRecordingSequence = 0;
const mockRecorders = new Map<string, FakeRecorder>();

function mockCreateRecorder(): FakeRecorder {
  const recorder: FakeRecorder = {
    isRecording: false,
    activeRecordingId: null,
    activeMetadata: null,
    activeTrajectoryBundle: null,
    start: jest.fn(),
    stop: jest.fn(),
  };

  recorder.start.mockImplementation(async (sessionId: string, options?: Record<string, unknown>) => {
    if (recorder.isRecording) throw new Error('A recording is already active. Call stop() first.');
    const id = `rec-20260728-120000-${String(++mockRecordingSequence).padStart(4, '0')}`;
    const metadata = {
      version: 1,
      id,
      sessionId,
      startedAt: '2026-07-28T12:00:00.000Z',
      actionCount: 0,
      label: options?.label,
      profile: options?.profile,
    };
    recorder.isRecording = true;
    recorder.activeRecordingId = id;
    recorder.activeMetadata = metadata;
    return metadata;
  });

  recorder.stop.mockImplementation(async () => {
    if (!recorder.isRecording || !recorder.activeMetadata) {
      throw new Error('No active recording. Call start() first.');
    }
    const metadata = {
      ...recorder.activeMetadata,
      stoppedAt: '2026-07-28T12:01:00.000Z',
    };
    recorder.isRecording = false;
    recorder.activeRecordingId = null;
    recorder.activeMetadata = null;
    return metadata;
  });

  return recorder;
}

const mockGlobalRecorder = mockCreateRecorder();
const mockGetOrCreateActionRecorder = jest.fn((sessionId: string) => {
  let recorder = mockRecorders.get(sessionId);
  if (!recorder) {
    recorder = mockCreateRecorder();
    mockRecorders.set(sessionId, recorder);
  }
  return recorder;
});
const mockGetActiveActionRecorder = jest.fn((sessionId: string) => {
  const recorder = mockRecorders.get(sessionId);
  return recorder?.isRecording ? recorder : undefined;
});

jest.mock('../../src/recording/action-recorder', () => ({
  beginSessionRecorderDeletion: jest.fn(),
  completeSessionRecorderDeletion: jest.fn(),
  getActionRecorder: jest.fn(() => mockGlobalRecorder),
  getOrCreateActionRecorder: mockGetOrCreateActionRecorder,
  getActiveActionRecorder: mockGetActiveActionRecorder,
  getActiveActionRecording: jest.fn(() => undefined),
  isSessionRecorderRegistered: jest.fn((sessionId: string, recorder: FakeRecorder) => (
    mockRecorders.get(sessionId) === recorder
  )),
  registerSessionRecorder: jest.fn((sessionId: string, recorder: FakeRecorder) => {
    mockRecorders.set(sessionId, recorder);
  }),
  unregisterSessionRecorder: jest.fn((sessionId: string) => {
    mockRecorders.delete(sessionId);
  }),
}));

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => ({
    getAllSessionInfos: jest.fn().mockReturnValue([]),
    getOrCreateSession: jest.fn().mockResolvedValue({}),
    cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
    deleteSession: jest.fn().mockResolvedValue(undefined),
    addEventListener: jest.fn(),
  })),
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn(() => ({
    isConnected: jest.fn().mockReturnValue(false),
    getProfileState: jest.fn().mockReturnValue({ type: 'temp', extensionsAvailable: false }),
  })),
}));

import { MCPServer } from '../../src/mcp-server';
import { registerRecordingTools } from '../../src/tools/recording';

function payload(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent ?? {};
}

describe('recording tool session isolation', () => {
  let server: MCPServer;

  beforeEach(() => {
    mockRecordingSequence = 0;
    mockRecorders.clear();
    mockGlobalRecorder.isRecording = false;
    mockGlobalRecorder.activeRecordingId = null;
    mockGlobalRecorder.activeMetadata = null;
    jest.clearAllMocks();

    server = new MCPServer();
    registerRecordingTools(server);
  });

  it('starts, reports, and stops recordings independently across sessions', async () => {
    const start = server.getToolHandler('oc_recording_start')!;
    const status = server.getToolHandler('oc_recording_status')!;
    const stop = server.getToolHandler('oc_recording_stop')!;

    const [startedA, startedB] = await Promise.all([
      start('session-a', { label: 'A' }),
      start('session-b', { label: 'B' }),
    ]);
    expect(startedA.isError).not.toBe(true);
    expect(startedB.isError).not.toBe(true);

    const statusA = payload(await status('session-a', {}));
    const statusB = payload(await status('session-b', {}));
    expect(statusA.active).toBe(true);
    expect(statusB.active).toBe(true);
    expect(statusA.recordingId).not.toBe(statusB.recordingId);

    const firstAId = statusA.recordingId;
    expect((await stop('session-a', {})).isError).not.toBe(true);
    expect(payload(await status('session-a', {})).active).toBe(false);
    expect(payload(await status('session-b', {})).active).toBe(true);

    expect((await start('session-a', { label: 'A2' })).isError).not.toBe(true);
    expect(payload(await status('session-a', {})).recordingId).not.toBe(firstAId);
  });

  it('does not expose or stop another session recording from an inactive session', async () => {
    const start = server.getToolHandler('oc_recording_start')!;
    const status = server.getToolHandler('oc_recording_status')!;
    const stop = server.getToolHandler('oc_recording_stop')!;

    await start('session-b', {});

    const inactiveA = payload(await status('session-a', {}));
    expect(inactiveA.active).toBe(false);
    expect(inactiveA.recordingId).toBeNull();
    expect(inactiveA.sessionId).toBeUndefined();

    expect((await stop('session-a', {})).isError).toBe(true);
    expect(payload(await status('session-b', {})).active).toBe(true);
    expect(mockGetOrCreateActionRecorder).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateActionRecorder).toHaveBeenCalledWith('session-b');
  });

  it('finalizes a start that loses session ownership before it completes', async () => {
    let markStartPending!: () => void;
    let releaseStart!: () => void;
    const startPending = new Promise<void>((resolve) => { markStartPending = resolve; });
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const recorder = mockCreateRecorder();
    const originalStart = recorder.start.getMockImplementation()!;
    recorder.start.mockImplementationOnce(async (sessionId: string, options?: Record<string, unknown>) => {
      markStartPending();
      await startGate;
      return originalStart(sessionId, options);
    });
    mockRecorders.set('session-a', recorder);
    const start = server.getToolHandler('oc_recording_start')!;

    const pendingResult = start('session-a', {});
    await startPending;
    mockRecorders.delete('session-a');
    releaseStart();

    const result = await pendingResult;

    expect(result.isError).toBe(true);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(recorder.isRecording).toBe(false);
  });
});
