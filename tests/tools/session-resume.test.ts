/// <reference types="jest" />
/**
 * Tests for Session Resume Tool (oc_session_resume)
 * Part of #355: AI Agent Continuity.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mock fs before imports that use it ───────────────────────────────────
jest.mock('fs');
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import {
  loadSnapshot,
  analyzeTabs,
  generateResumeGuide,
  SNAPSHOT_DIR,
  registerSessionResumeTool,
} from '../../src/tools/session-resume';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<{
  id: string;
  timestamp: number;
  tabs: unknown[];
  memo: unknown;
  label: string;
  version: number;
}> = {}) {
  return {
    version: 1,
    id: 'snap-abc123',
    timestamp: Date.now() - 5000,
    tabs: [],
    memo: {
      objective: 'Fill out the registration form',
      currentStep: 'Submitted form, waiting for confirmation',
      nextActions: ['Check confirmation email', 'Screenshot the result'],
      completedSteps: ['Navigated to form', 'Filled in all fields'],
      notes: 'Use test@example.com',
    },
    label: 'after-form-submit',
    ...overrides,
  };
}

function makeTab(overrides: Partial<{
  targetId: string;
  workerId: string;
  sessionId: string;
  url: string;
  title: string;
}> = {}) {
  return {
    targetId: 'target-aaa',
    workerId: 'default',
    sessionId: 'session-111',
    url: 'https://example.com/form',
    title: 'Registration Form',
    ...overrides,
  };
}

function makeMockPage(url: string) {
  return { url: jest.fn().mockReturnValue(url) };
}

function makeMockSessionManager(options: {
  getPage?: jest.Mock;
  getAllSessionInfos?: jest.Mock;
  getWorkerTargetIds?: jest.Mock;
} = {}) {
  return {
    getPage: options.getPage ?? jest.fn().mockRejectedValue(new Error('Target not found')),
    getAllSessionInfos: options.getAllSessionInfos ?? jest.fn().mockReturnValue([]),
    getWorkerTargetIds: options.getWorkerTargetIds ?? jest.fn().mockReturnValue([]),
  };
}

// ─── loadSnapshot ─────────────────────────────────────────────────────────

describe('loadSnapshot', () => {
  const mockReadFileSync = fs.readFileSync as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reads latest.json when no snapshotId given', () => {
    const snap = makeSnapshot();
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    const result = loadSnapshot();

    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(SNAPSHOT_DIR, 'latest.json'),
      'utf-8',
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe('snap-abc123');
  });

  test('reads <id>.json when snapshotId is given', () => {
    const snap = makeSnapshot({ id: 'snap-xyz' });
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    const result = loadSnapshot('snap-xyz');

    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(SNAPSHOT_DIR, 'snap-xyz.json'),
      'utf-8',
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe('snap-xyz');
  });

  test('returns null when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT: no such file'); });

    const result = loadSnapshot();

    expect(result).toBeNull();
  });

  test('returns null when JSON is invalid', () => {
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result = loadSnapshot();

    expect(result).toBeNull();
  });

  test('returns null when version is not 1', () => {
    const snap = makeSnapshot({ version: 2 });
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    const result = loadSnapshot();

    expect(result).toBeNull();
  });
});

// ─── analyzeTabs ─────────────────────────────────────────────────────────

describe('analyzeTabs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns LIVE when targetId found in same session', async () => {
    const tab = makeTab();
    const page = makeMockPage('https://example.com/form');
    const sm = makeMockSessionManager({
      getPage: jest.fn().mockResolvedValue(page),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const result = await analyzeTabs([tab]);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('LIVE');
    expect(result[0].currentTargetId).toBe('target-aaa');
    expect(result[0].currentUrl).toBe('https://example.com/form');
  });

  test('returns REMAPPED when targetId gone but URL matches another tab', async () => {
    const tab = makeTab({ targetId: 'target-old', url: 'https://example.com/form' });

    // getPage for saved targetId throws, but getPage for a different target returns matching URL
    const page = makeMockPage('https://example.com/form');
    const getPageMock = jest.fn()
      .mockRejectedValueOnce(new Error('Target not found'))  // first call: exact match fails
      .mockResolvedValue(page);                              // subsequent calls: URL scan succeeds

    const sm = makeMockSessionManager({
      getPage: getPageMock,
      getAllSessionInfos: jest.fn().mockReturnValue([
        {
          id: 'session-111',
          workers: [{ id: 'default', targetCount: 1 }],
        },
      ]),
      getWorkerTargetIds: jest.fn().mockReturnValue(['target-new']),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const result = await analyzeTabs([tab]);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('REMAPPED');
    expect(result[0].currentTargetId).toBe('target-new');
    expect(result[0].saved.targetId).toBe('target-old');
  });

  test('returns CLOSED when neither targetId nor URL matches', async () => {
    const tab = makeTab({ url: 'https://gone.example.com' });
    const page = makeMockPage('https://different.com');
    const getPageMock = jest.fn()
      .mockRejectedValueOnce(new Error('Target not found'))  // exact match fails
      .mockResolvedValue(page);                              // URL scan: different URL

    const sm = makeMockSessionManager({
      getPage: getPageMock,
      getAllSessionInfos: jest.fn().mockReturnValue([
        {
          id: 'session-111',
          workers: [{ id: 'default', targetCount: 1 }],
        },
      ]),
      getWorkerTargetIds: jest.fn().mockReturnValue(['target-other']),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const result = await analyzeTabs([tab]);

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('CLOSED');
  });

  test('returns CLOSED for all tabs when Chrome is disconnected', async () => {
    const tabs = [
      makeTab({ targetId: 'target-aaa' }),
      makeTab({ targetId: 'target-bbb', url: 'https://other.com' }),
    ];
    const sm = makeMockSessionManager({
      getPage: jest.fn().mockRejectedValue(new Error('Chrome disconnected')),
      getAllSessionInfos: jest.fn().mockReturnValue([]),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const result = await analyzeTabs(tabs);

    expect(result).toHaveLength(2);
    expect(result.every(r => r.status === 'CLOSED')).toBe(true);
  });

  test('handles empty tabs array', async () => {
    const sm = makeMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const result = await analyzeTabs([]);

    expect(result).toHaveLength(0);
  });

  test('analyzes multiple tabs independently', async () => {
    const liveTab = makeTab({ targetId: 'target-live', url: 'https://live.com' });
    const closedTab = makeTab({ targetId: 'target-dead', url: 'https://dead.com' });

    const livePage = makeMockPage('https://live.com');
    const getPageMock = jest.fn()
      .mockResolvedValueOnce(livePage)        // first tab: exact match -> LIVE
      .mockRejectedValueOnce(new Error('not found'))  // second tab exact match fails
      .mockResolvedValue(makeMockPage('https://unrelated.com')); // URL scan: no match

    const sm = makeMockSessionManager({
      getPage: getPageMock,
      getAllSessionInfos: jest.fn().mockReturnValue([
        { id: 'session-111', workers: [{ id: 'default', targetCount: 1 }] },
      ]),
      getWorkerTargetIds: jest.fn().mockReturnValue(['target-other']),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const result = await analyzeTabs([liveTab, closedTab]);

    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('LIVE');
    expect(result[1].status).toBe('CLOSED');
  });
});

// ─── generateResumeGuide ─────────────────────────────────────────────────

describe('generateResumeGuide', () => {
  test('includes objective and last step', () => {
    const snap = makeSnapshot() as ReturnType<typeof makeSnapshot>;
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('Fill out the registration form');
    expect(guide).toContain('Submitted form, waiting for confirmation');
  });

  test('includes snapshot age', () => {
    const snap = makeSnapshot({ timestamp: Date.now() - 5000 });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toMatch(/Snapshot age: \d+s/);
  });

  test('includes label when present', () => {
    const snap = makeSnapshot({ label: 'after-form-submit' });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('after-form-submit');
  });

  test('shows tab counts correctly', () => {
    const snap = makeSnapshot();
    const tabAnalysis = [
      { saved: makeTab(), status: 'LIVE' as const, currentTargetId: 'target-aaa', currentUrl: 'https://example.com' },
      { saved: makeTab({ targetId: 'target-bbb' }), status: 'REMAPPED' as const, currentTargetId: 'target-ccc', currentUrl: 'https://example.com' },
      { saved: makeTab({ targetId: 'target-ddd' }), status: 'CLOSED' as const },
    ];

    const guide = generateResumeGuide(snap as any, tabAnalysis);

    expect(guide).toContain('1 LIVE');
    expect(guide).toContain('1 REMAPPED');
    expect(guide).toContain('1 CLOSED');
  });

  test('shows LIVE tab with targetId', () => {
    const snap = makeSnapshot();
    const tabAnalysis = [
      { saved: makeTab({ targetId: 'target-aaa', url: 'https://example.com', title: 'My Page' }), status: 'LIVE' as const, currentTargetId: 'target-aaa', currentUrl: 'https://example.com' },
    ];

    const guide = generateResumeGuide(snap as any, tabAnalysis);

    expect(guide).toContain('LIVE');
    expect(guide).toContain('target-aaa');
    expect(guide).toContain('https://example.com');
    expect(guide).toContain('"My Page"');
  });

  test('shows REMAPPED tab with old -> new targetId', () => {
    const snap = makeSnapshot();
    const tabAnalysis = [
      {
        saved: makeTab({ targetId: 'target-old', url: 'https://example.com' }),
        status: 'REMAPPED' as const,
        currentTargetId: 'target-new',
        currentUrl: 'https://example.com',
      },
    ];

    const guide = generateResumeGuide(snap as any, tabAnalysis);

    expect(guide).toContain('REMAPPED');
    expect(guide).toContain('target-old');
    expect(guide).toContain('target-new');
  });

  test('shows CLOSED tab with URL', () => {
    const snap = makeSnapshot();
    const tabAnalysis = [
      { saved: makeTab({ url: 'https://closed.example.com' }), status: 'CLOSED' as const },
    ];

    const guide = generateResumeGuide(snap as any, tabAnalysis);

    expect(guide).toContain('CLOSED');
    expect(guide).toContain('https://closed.example.com');
  });

  test('includes completed steps', () => {
    const snap = makeSnapshot();
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('Completed:');
    expect(guide).toContain('Navigated to form');
    expect(guide).toContain('Filled in all fields');
  });

  test('includes next actions with numbering', () => {
    const snap = makeSnapshot();
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('Next actions:');
    expect(guide).toContain('1. Check confirmation email');
    expect(guide).toContain('2. Screenshot the result');
  });

  test('includes notes when present', () => {
    const snap = makeSnapshot();
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('Notes: Use test@example.com');
  });

  test('omits completed steps section when empty', () => {
    const snap = makeSnapshot({
      memo: {
        objective: 'Do something',
        currentStep: 'Working',
        nextActions: ['Step A'],
        // no completedSteps
      },
    });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).not.toContain('Completed:');
  });

  test('omits notes section when absent', () => {
    const snap = makeSnapshot({
      memo: {
        objective: 'Do something',
        currentStep: 'Working',
        nextActions: ['Step A'],
        // no notes
      },
    });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).not.toContain('Notes:');
  });

  test('shows stale warning for snapshots over 24 hours old', () => {
    const snap = makeSnapshot({ timestamp: Date.now() - 25 * 3600000 });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('WARNING');
    expect(guide).toContain('24 hours');
  });

  test('does not show stale warning for recent snapshots', () => {
    const snap = makeSnapshot({ timestamp: Date.now() - 60000 });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).not.toContain('WARNING');
  });

  test('age shown in minutes for snapshots 1-59 min old', () => {
    const snap = makeSnapshot({ timestamp: Date.now() - 10 * 60000 });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toMatch(/Snapshot age: \d+m/);
  });

  test('age shown in hours for snapshots 1+ hours old', () => {
    const snap = makeSnapshot({ timestamp: Date.now() - 2 * 3600000 });
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toMatch(/Snapshot age: \d+h/);
  });

  test('handles empty tabs array gracefully', () => {
    const snap = makeSnapshot();
    const guide = generateResumeGuide(snap as any, []);

    expect(guide).toContain('0 LIVE, 0 REMAPPED, 0 CLOSED');
  });
});

// ─── Handler ─────────────────────────────────────────────────────────────

describe('oc_session_resume handler', () => {
  const mockReadFileSync = fs.readFileSync as jest.Mock;

  const getHandler = async () => {
    jest.resetModules();
    jest.doMock('fs', () => ({ readFileSync: mockReadFileSync }));
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: getSessionManager,
    }));

    const { registerSessionResumeTool } = await import('../../src/tools/session-resume');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
      },
    };

    registerSessionResumeTool(mockServer as any);
    return tools.get('oc_session_resume')!.handler;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no snapshot file
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  });

  test('returns "No snapshot found" when no file exists', async () => {
    const sm = makeMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const handler = await getHandler();
    const result = await handler('session-x', {}) as any;

    expect(result.content[0].text).toContain('No snapshot found');
    expect(result.content[0].text).toContain('oc_session_snapshot');
  });

  test('returns "No snapshot found" with snapshotId when specific ID missing', async () => {
    const sm = makeMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const handler = await getHandler();
    const result = await handler('session-x', { snapshotId: 'missing-snap' }) as any;

    expect(result.content[0].text).toContain('No snapshot found');
    expect(result.content[0].text).toContain('"missing-snap"');
  });

  test('returns full resume guide when snapshot exists with no tabs', async () => {
    const snap = makeSnapshot({ tabs: [] });
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    const sm = makeMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const handler = await getHandler();
    const result = await handler('session-x', {}) as any;

    expect(result.content[0].text).toContain('CONTEXT RESTORED');
    expect(result.content[0].text).toContain('Fill out the registration form');
    expect(result._snapshotId).toBe('snap-abc123');
  });

  test('includes tab analysis in guide when snapshot has tabs', async () => {
    const tab = makeTab();
    const snap = makeSnapshot({ tabs: [tab] });
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    // Chrome connected, tab is LIVE
    const page = makeMockPage('https://example.com/form');
    const sm = makeMockSessionManager({
      getPage: jest.fn().mockResolvedValue(page),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const handler = await getHandler();
    const result = await handler('session-x', {}) as any;

    expect(result.content[0].text).toContain('1 LIVE');
  });

  test('gracefully degrades to CLOSED when Chrome is disconnected', async () => {
    const tab = makeTab();
    const snap = makeSnapshot({ tabs: [tab] });
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    // Chrome is disconnected — analyzeTabs throws entirely
    const sm = makeMockSessionManager({
      getPage: jest.fn().mockRejectedValue(new Error('CDP disconnected')),
      getAllSessionInfos: jest.fn().mockImplementation(() => { throw new Error('CDP disconnected'); }),
    });
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const handler = await getHandler();
    const result = await handler('session-x', {}) as any;

    // Should still return a guide, not crash
    expect(result.content[0].text).toContain('CONTEXT RESTORED');
    expect(result.content[0].text).toContain('CLOSED');
  });

  test('passes snapshotId to loadSnapshot', async () => {
    const snap = makeSnapshot({ id: 'my-snap' });
    mockReadFileSync.mockReturnValue(JSON.stringify(snap));

    const sm = makeMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(sm);

    const handler = await getHandler();
    await handler('session-x', { snapshotId: 'my-snap' });

    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(SNAPSHOT_DIR, 'my-snap.json'),
      'utf-8',
    );
  });
});

// ─── registerSessionResumeTool ────────────────────────────────────────────

describe('registerSessionResumeTool', () => {
  test('registers tool with correct name', () => {
    const tools: Map<string, unknown> = new Map();
    const mockServer = {
      registerTool: jest.fn((name: string, handler: unknown, def: unknown) => {
        tools.set(name, { handler, def });
      }),
    };

    registerSessionResumeTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'oc_session_resume',
      expect.any(Function),
      expect.objectContaining({ name: 'oc_session_resume' }),
    );
  });
});
