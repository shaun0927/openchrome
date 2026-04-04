/// <reference types="jest" />
/**
 * Tests for oc_recording_* tools (#572: Session Recording & Replay).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockStart = jest.fn();
const mockStop = jest.fn();
let mockIsRecording = false;
let mockActiveRecordingId: string | null = null;

jest.mock('../../src/recording/action-recorder', () => ({
  getActionRecorder: jest.fn(() => ({
    get isRecording() { return mockIsRecording; },
    get activeRecordingId() { return mockActiveRecordingId; },
    start: mockStart,
    stop: mockStop,
  })),
}));

const mockListRecordings = jest.fn();
const mockReadMetadata = jest.fn();
const mockReadActions = jest.fn();
const mockGetRecordingSize = jest.fn();
const mockGetRecordingDir = jest.fn();
const mockReadScreenshot = jest.fn();

jest.mock('../../src/recording/recording-store', () => ({
  getRecordingStore: jest.fn(() => ({
    listRecordings: mockListRecordings,
    readMetadata: mockReadMetadata,
    readActions: mockReadActions,
    getRecordingSize: mockGetRecordingSize,
    getRecordingDir: mockGetRecordingDir,
    readScreenshot: mockReadScreenshot,
  })),
}));

// Satisfy MCPServer constructor dependencies
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => ({
    getAllSessionInfos: jest.fn().mockReturnValue([]),
    getOrCreateSession: jest.fn().mockResolvedValue({}),
    cleanupAllSessions: jest.fn().mockResolvedValue(undefined),
    deleteSession: jest.fn().mockResolvedValue(undefined),
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    id: 'rec-20240101-120000-abcd',
    sessionId: 'default',
    startedAt: '2024-01-01T12:00:00.000Z',
    stoppedAt: '2024-01-01T12:01:00.000Z',
    actionCount: 5,
    label: 'Test recording',
    profile: undefined,
    ...overrides,
  };
}

function makeAction(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    ts: new Date('2024-01-01T12:00:05.000Z').getTime(),
    tool: 'navigate',
    args: { url: 'https://example.com' },
    durationMs: 250,
    ok: true,
    summary: '✓ navigate',
    url: 'https://example.com',
    ...overrides,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('recording tools', () => {
  let server: MCPServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsRecording = false;
    mockActiveRecordingId = null;

    // Default mock implementations
    mockListRecordings.mockResolvedValue([]);
    mockReadMetadata.mockResolvedValue(null);
    mockReadActions.mockReturnValue([]);
    mockGetRecordingSize.mockResolvedValue(0);
    mockGetRecordingDir.mockReturnValue('/tmp/recordings/rec-test');
    mockReadScreenshot.mockResolvedValue(null);

    server = new MCPServer();
    registerRecordingTools(server);
  });

  // ─── Registration ──────────────────────────────────────────────────────────

  describe('registration', () => {
    test('registers all four tools', () => {
      const names = server.getToolNames();
      expect(names).toContain('oc_recording_start');
      expect(names).toContain('oc_recording_stop');
      expect(names).toContain('oc_recording_list');
      expect(names).toContain('oc_recording_export');
    });
  });

  // ─── oc_recording_start ────────────────────────────────────────────────────

  describe('oc_recording_start', () => {
    let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

    beforeEach(() => {
      handler = server.getToolHandler('oc_recording_start')!;
      expect(handler).toBeDefined();
    });

    test('starts recording and returns recording ID', async () => {
      const metadata = makeMetadata({ stoppedAt: undefined });
      mockStart.mockResolvedValue(metadata);

      const result = await handler('default', { label: 'Test', profile: 'default' });

      expect(mockStart).toHaveBeenCalledWith('default', { label: 'Test', profile: 'default' });
      expect(result.isError).toBeFalsy();
      const text: string = result.content[0].text;
      expect(text).toContain('Recording started');
      expect(text).toContain('rec-20240101-120000-abcd');
    });

    test('returns error if already recording', async () => {
      mockIsRecording = true;
      mockActiveRecordingId = 'rec-20240101-110000-zzzz';

      const result = await handler('default', {});

      expect(mockStart).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const text: string = result.content[0].text;
      expect(text).toContain('already active');
      expect(text).toContain('rec-20240101-110000-zzzz');
    });

    test('returns error if start() throws', async () => {
      mockStart.mockRejectedValue(new Error('disk full'));

      const result = await handler('default', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('disk full');
    });

    test('includes label and profile in output when provided', async () => {
      const metadata = makeMetadata({ stoppedAt: undefined, label: 'My label', profile: 'work' });
      mockStart.mockResolvedValue(metadata);

      const result = await handler('default', { label: 'My label', profile: 'work' });
      const text: string = result.content[0].text;

      expect(text).toContain('My label');
      expect(text).toContain('work');
    });
  });

  // ─── oc_recording_stop ─────────────────────────────────────────────────────

  describe('oc_recording_stop', () => {
    let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

    beforeEach(() => {
      handler = server.getToolHandler('oc_recording_stop')!;
      expect(handler).toBeDefined();
    });

    test('stops recording and returns summary', async () => {
      mockIsRecording = true;
      const metadata = makeMetadata();
      mockStop.mockResolvedValue(metadata);

      const result = await handler('default', {});

      expect(mockStop).toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      const text: string = result.content[0].text;
      expect(text).toContain('Recording stopped');
      expect(text).toContain('rec-20240101-120000-abcd');
      expect(text).toContain('5'); // actionCount
      expect(text).toContain('60.0s'); // duration
    });

    test('returns error if not recording', async () => {
      mockIsRecording = false;

      const result = await handler('default', {});

      expect(mockStop).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No active recording');
    });

    test('returns error if stop() throws', async () => {
      mockIsRecording = true;
      mockStop.mockRejectedValue(new Error('io error'));

      const result = await handler('default', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('io error');
    });
  });

  // ─── oc_recording_list ─────────────────────────────────────────────────────

  describe('oc_recording_list', () => {
    let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

    beforeEach(() => {
      handler = server.getToolHandler('oc_recording_list')!;
      expect(handler).toBeDefined();
    });

    test('returns empty message when no recordings exist', async () => {
      mockListRecordings.mockResolvedValue([]);

      const result = await handler('default', {});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('No recordings found');
    });

    test('lists recordings with metadata', async () => {
      const id = 'rec-20240101-120000-abcd';
      mockListRecordings.mockResolvedValue([id]);
      mockReadMetadata.mockResolvedValue(makeMetadata());
      mockGetRecordingSize.mockResolvedValue(4096);

      const result = await handler('default', {});

      expect(result.isError).toBeFalsy();
      const text: string = result.content[0].text;
      expect(text).toContain(id);
      expect(text).toContain('5'); // actionCount
      expect(text).toContain('4.0 KB');
      expect(text).toContain('60.0s');
      expect(text).toContain('Test recording');
    });

    test('handles missing metadata gracefully', async () => {
      const id = 'rec-20240101-120000-abcd';
      mockListRecordings.mockResolvedValue([id]);
      mockReadMetadata.mockResolvedValue(null);

      const result = await handler('default', {});

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('metadata unavailable');
    });

    test('respects limit parameter', async () => {
      const ids = ['rec-1', 'rec-2', 'rec-3', 'rec-4', 'rec-5'];
      mockListRecordings.mockResolvedValue(ids);
      mockReadMetadata.mockResolvedValue(makeMetadata());
      mockGetRecordingSize.mockResolvedValue(0);

      const result = await handler('default', { limit: 2 });

      expect(mockReadMetadata).toHaveBeenCalledTimes(2);
    });

    test('uses default limit of 20', async () => {
      const ids = Array.from({ length: 25 }, (_, i) => `rec-${i}`);
      mockListRecordings.mockResolvedValue(ids);
      mockReadMetadata.mockResolvedValue(makeMetadata());
      mockGetRecordingSize.mockResolvedValue(0);

      const result = await handler('default', {});

      expect(mockReadMetadata).toHaveBeenCalledTimes(20);
    });
  });

  // ─── oc_recording_export ───────────────────────────────────────────────────

  describe('oc_recording_export', () => {
    let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;
    let tmpDir: string;

    beforeEach(() => {
      handler = server.getToolHandler('oc_recording_export')!;
      expect(handler).toBeDefined();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));
      mockGetRecordingDir.mockReturnValue(tmpDir);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('exports JSON format with metadata and actions', async () => {
      const metadata = makeMetadata();
      const actions = [makeAction(), makeAction({ seq: 2, tool: 'read_page' })];
      mockReadMetadata.mockResolvedValue(metadata);
      mockReadActions.mockReturnValue(actions);

      const result = await handler('default', { recordingId: 'rec-20240101-120000-abcd' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.metadata.id).toBe('rec-20240101-120000-abcd');
      expect(parsed.actions).toHaveLength(2);
      expect(parsed.actions[0].tool).toBe('navigate');
      expect(parsed.actions[1].tool).toBe('read_page');
    });

    test('JSON is the default format', async () => {
      mockReadMetadata.mockResolvedValue(makeMetadata());
      mockReadActions.mockReturnValue([]);

      const result = await handler('default', { recordingId: 'rec-20240101-120000-abcd' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.metadata).toBeDefined();
      expect(parsed.actions).toBeDefined();
    });

    test('exports HTML format and returns file path', async () => {
      const metadata = makeMetadata();
      const actions = [makeAction()];
      mockReadMetadata.mockResolvedValue(metadata);
      mockReadActions.mockReturnValue(actions);

      const result = await handler('default', {
        recordingId: 'rec-20240101-120000-abcd',
        format: 'html',
      });

      expect(result.isError).toBeFalsy();
      const text: string = result.content[0].text;
      expect(text).toContain('report.html');

      // Verify file was written
      const htmlPath = path.join(tmpDir, 'report.html');
      expect(fs.existsSync(htmlPath)).toBe(true);
      const html = fs.readFileSync(htmlPath, 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('rec-20240101-120000-abcd');
      expect(html).toContain('navigate');
    });

    test('HTML includes action details', async () => {
      const metadata = makeMetadata({ label: 'My recording' });
      const actions = [
        makeAction({ ok: false, error: 'element not found', summary: '✗ interact' }),
      ];
      mockReadMetadata.mockResolvedValue(metadata);
      mockReadActions.mockReturnValue(actions);

      await handler('default', {
        recordingId: 'rec-20240101-120000-abcd',
        format: 'html',
      });

      const htmlPath = path.join(tmpDir, 'report.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      expect(html).toContain('element not found');
      expect(html).toContain('My recording');
    });

    test('returns error for nonexistent recording', async () => {
      mockReadMetadata.mockResolvedValue(null);

      const result = await handler('default', { recordingId: 'rec-does-not-exist' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    test('returns error for unknown format', async () => {
      mockReadMetadata.mockResolvedValue(makeMetadata());
      mockReadActions.mockReturnValue([]);

      const result = await handler('default', {
        recordingId: 'rec-20240101-120000-abcd',
        format: 'csv',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown format');
    });

    test('HTML embeds screenshots as base64 when present', async () => {
      const metadata = makeMetadata();
      const action = makeAction({
        screenshotBefore: 'screenshot-1-before.webp',
        screenshotAfter: 'screenshot-1-after.webp',
      });
      mockReadMetadata.mockResolvedValue(metadata);
      mockReadActions.mockReturnValue([action]);
      // Return a small buffer as "image data"
      mockReadScreenshot.mockResolvedValue(Buffer.from('fake-image-data'));

      await handler('default', {
        recordingId: 'rec-20240101-120000-abcd',
        format: 'html',
      });

      const htmlPath = path.join(tmpDir, 'report.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      // base64 of "fake-image-data"
      const b64 = Buffer.from('fake-image-data').toString('base64');
      expect(html).toContain(`data:image/webp;base64,${b64}`);
      expect(html).toContain('Before');
      expect(html).toContain('After');
    });
  });
});
