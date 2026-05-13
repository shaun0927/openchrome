/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => ({
    getAllSessionInfos: jest.fn(() => []),
    getWorkerTargetIds: jest.fn(() => []),
    getPage: jest.fn(),
  })),
}));

jest.mock('../../src/recording/action-recorder', () => ({
  getActiveActionRecorder: jest.fn(() => undefined),
}));

type Handler = (sessionId: string, args: Record<string, unknown>) => Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>;

async function loadHandler(): Promise<Handler> {
  jest.resetModules();
  const { registerCheckpointTool } = await import('../../src/tools/checkpoint');
  let handler: Handler | undefined;
  registerCheckpointTool({
    registerTool: (_name: string, h: Handler) => {
      handler = h;
    },
  } as any);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

function readJson(result: Awaited<ReturnType<Handler>>): any {
  return JSON.parse(result.content?.[0]?.text || '{}');
}

describe('oc_checkpoint timeline (#1025)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-checkpoint-timeline-'));
    process.env.OPENCHROME_CHECKPOINT_DIR = tmpDir;
    process.env.OPENCHROME_CHECKPOINT_TIMELINE_MAX = '10';
  });

  afterEach(() => {
    delete process.env.OPENCHROME_CHECKPOINT_DIR;
    delete process.env.OPENCHROME_CHECKPOINT_TIMELINE_MAX;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('save returns checkpoint id and list returns newest-first timeline entries', async () => {
    const handler = await loadHandler();

    const first = readJson(await handler('sess-1', {
      action: 'save',
      label: 'first',
      taskDescription: 'task',
      completedSteps: ['one'],
      pendingSteps: ['two'],
    }));
    const second = readJson(await handler('sess-1', {
      action: 'save',
      label: 'second',
      taskDescription: 'task',
      completedSteps: ['one', 'two'],
      pendingSteps: [],
    }));

    expect(first.status).toBe('saved');
    expect(first.checkpointId).toMatch(/^cp_/);
    expect(second.parentId).toBe(first.checkpointId);

    const listed = readJson(await handler('sess-1', { action: 'list' }));
    expect(listed.status).toBe('listed');
    expect(listed.checkpoints.map((entry: any) => entry.checkpointId)).toEqual([
      second.checkpointId,
      first.checkpointId,
    ]);
    expect(listed.checkpoints[0].label).toBe('second');
    expect(listed.checkpoints[0].pendingSteps).toBe(0);
  });

  test('load supports latest compatibility and specific checkpoint id', async () => {
    const handler = await loadHandler();

    const first = readJson(await handler('sess-1', {
      action: 'save',
      taskDescription: 'first task',
      completedSteps: ['a'],
      pendingSteps: ['b'],
    }));
    const second = readJson(await handler('sess-1', {
      action: 'save',
      taskDescription: 'second task',
      completedSteps: ['c'],
      pendingSteps: [],
    }));

    const latest = readJson(await handler('sess-1', { action: 'load' }));
    expect(latest.checkpointId).toBe(second.checkpointId);
    expect(latest.taskDescription).toBe('second task');

    const older = readJson(await handler('sess-1', { action: 'load', checkpointId: first.checkpointId }));
    expect(older.checkpointId).toBe(first.checkpointId);
    expect(older.taskDescription).toBe('first task');
    expect(older.pendingSteps).toEqual(['b']);
  });

  test('list handles empty and corrupt timeline entries without throwing', async () => {
    const handler = await loadHandler();

    expect(readJson(await handler('sess-1', { action: 'list' })).checkpoints).toEqual([]);

    const timelineDir = path.join(tmpDir, 'timeline');
    fs.mkdirSync(timelineDir, { recursive: true });
    fs.writeFileSync(path.join(timelineDir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(timelineDir, 'invalid.json'), JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      checkpointId: 'cp_invalid_shape',
      taskDescription: 'bad',
      completedSteps: 'not-an-array',
      pendingSteps: [],
      currentUrl: null,
      tabStates: [],
      extractedData: {},
    }));

    const listed = readJson(await handler('sess-1', { action: 'list' }));
    expect(listed.checkpoints).toEqual([]);
    expect(listed.warnings.join('\n')).toContain('Skipped corrupt checkpoint timeline entry');
    expect(listed.warnings.join('\n')).toContain('Skipped invalid checkpoint timeline entry');
  });

  test('load falls back to newest timeline entry when current checkpoint is missing', async () => {
    const handler = await loadHandler();

    const first = readJson(await handler('sess-1', {
      action: 'save',
      taskDescription: 'timeline fallback',
      completedSteps: ['saved'],
      pendingSteps: [],
    }));
    fs.unlinkSync(path.join(tmpDir, 'current-checkpoint.json'));

    const loaded = readJson(await handler('sess-1', { action: 'load' }));
    expect(loaded.status).toBe('loaded');
    expect(loaded.checkpointId).toBe(first.checkpointId);
    expect(loaded.taskDescription).toBe('timeline fallback');
  });


  test('load by checkpoint id rejects schema-invalid timeline files', async () => {
    const handler = await loadHandler();
    const timelineDir = path.join(tmpDir, 'timeline');
    fs.mkdirSync(timelineDir, { recursive: true });
    fs.writeFileSync(path.join(timelineDir, 'cp_bad.json'), JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      checkpointId: 'cp_bad',
      taskDescription: 'bad',
      completedSteps: 'not-an-array',
      pendingSteps: [],
      currentUrl: null,
      tabStates: [],
      extractedData: {},
    }));

    const loaded = await handler('sess-1', { action: 'load', checkpointId: 'cp_bad' });
    expect(loaded.content?.[0]?.text).toContain('No checkpoint found for checkpointId "cp_bad"');
  });

  test('legacy delete removes current checkpoint and its timeline entry', async () => {
    const handler = await loadHandler();
    const saved = readJson(await handler('sess-1', {
      action: 'save',
      taskDescription: 'delete me',
      completedSteps: ['done'],
      pendingSteps: [],
    }));

    const deleted = await handler('sess-1', { action: 'delete' });
    expect(deleted.content?.[0]?.text).toBe('Checkpoint deleted.');
    expect(fs.existsSync(path.join(tmpDir, 'current-checkpoint.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'timeline', `${saved.checkpointId}.json`))).toBe(false);
    expect(readJson(await handler('sess-1', { action: 'list' })).checkpoints).toEqual([]);
  });

  test('retention prunes old timeline artifacts only', async () => {
    process.env.OPENCHROME_CHECKPOINT_TIMELINE_MAX = '2';
    const handler = await loadHandler();

    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(readJson(await handler('sess-1', {
        action: 'save',
        label: `cp-${i}`,
        taskDescription: `task ${i}`,
      })).checkpointId);
    }

    const listed = readJson(await handler('sess-1', { action: 'list' }));
    expect(listed.checkpoints).toHaveLength(2);
    expect(listed.checkpoints.map((entry: any) => entry.checkpointId)).toEqual(ids.slice(2).reverse());
    expect(fs.existsSync(path.join(tmpDir, 'current-checkpoint.json'))).toBe(true);
  });
});
