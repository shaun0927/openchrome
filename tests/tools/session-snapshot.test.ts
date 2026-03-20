/// <reference types="jest" />
/**
 * Tests for oc_session_snapshot tool
 * Part of #355: AI Agent Continuity
 */

import * as path from 'path';
import * as os from 'os';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/atomic-file', () => ({
  writeFileAtomicSafe: jest.fn().mockResolvedValue(undefined),
}));

// fs.promises is mocked selectively per test via jest.spyOn
import { getSessionManager } from '../../src/session-manager';
import { writeFileAtomicSafe } from '../../src/utils/atomic-file';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockPage(url: string, title: string) {
  return {
    url: jest.fn().mockReturnValue(url),
    title: jest.fn().mockResolvedValue(title),
    isClosed: jest.fn().mockReturnValue(false),
  };
}

function makeMockSessionManager(sessions: Array<{
  id: string;
  workers: Array<{ id: string; targetIds: string[] }>;
  pages?: Record<string, { url: string; title: string }>;
}>) {
  const sessionInfos = sessions.map(s => ({
    id: s.id,
    name: `Session ${s.id}`,
    workerCount: s.workers.length,
    targetCount: s.workers.reduce((sum, w) => sum + w.targetIds.length, 0),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    workers: s.workers.map(w => ({
      id: w.id,
      name: `Worker ${w.id}`,
      targetCount: w.targetIds.length,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    })),
  }));

  const pagesByTarget: Record<string, ReturnType<typeof makeMockPage>> = {};
  for (const s of sessions) {
    for (const w of s.workers) {
      for (const targetId of w.targetIds) {
        const pageData = s.pages?.[targetId] ?? { url: 'about:blank', title: '' };
        pagesByTarget[targetId] = makeMockPage(pageData.url, pageData.title);
      }
    }
  }

  const workerTargetIds: Record<string, Record<string, string[]>> = {};
  for (const s of sessions) {
    workerTargetIds[s.id] = {};
    for (const w of s.workers) {
      workerTargetIds[s.id][w.id] = w.targetIds;
    }
  }

  return {
    getAllSessionInfos: jest.fn().mockReturnValue(sessionInfos),
    getWorkerTargetIds: jest.fn().mockImplementation((sessionId: string, workerId: string) => {
      return workerTargetIds[sessionId]?.[workerId] ?? [];
    }),
    getPage: jest.fn().mockImplementation(async (sessionId: string, targetId: string) => {
      return pagesByTarget[targetId] ?? null;
    }),
    _pagesByTarget: pagesByTarget,
  };
}

// ─── Handler Factory ─────────────────────────────────────────────────────────

async function getSnapshotHandler() {
  const { registerSessionSnapshotTool } = await import('../../src/tools/session-snapshot');

  const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown> }> = new Map();
  const mockServer = {
    registerTool: (name: string, handler: unknown) => {
      tools.set(name, { handler: handler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown> });
    },
  };

  registerSessionSnapshotTool(mockServer as unknown as Parameters<typeof registerSessionSnapshotTool>[0]);
  return tools.get('oc_session_snapshot')!.handler;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('oc_session_snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (writeFileAtomicSafe as jest.Mock).mockResolvedValue(undefined);
  });

  // ── Snapshot ID format ───────────────────────────────────────────────────

  describe('generateSnapshotId', () => {
    test('returns snap- prefixed string with timestamp and hex suffix', async () => {
      const { generateSnapshotId } = await import('../../src/tools/session-snapshot');
      const id = generateSnapshotId();
      expect(id).toMatch(/^snap-\d{8}-\d{6}-[0-9a-f]{4}$/);
    });

    test('generates unique IDs on successive calls', async () => {
      const { generateSnapshotId } = await import('../../src/tools/session-snapshot');
      const ids = new Set(Array.from({ length: 20 }, () => generateSnapshotId()));
      // With random hex suffix the probability of collision is negligible
      expect(ids.size).toBeGreaterThan(1);
    });
  });

  // ── Tab collection ───────────────────────────────────────────────────────

  describe('collectTabs', () => {
    test('returns empty array when no sessions exist', async () => {
      const mockSM = makeMockSessionManager([]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();
      expect(tabs).toEqual([]);
    });

    test('returns tabs for a single session with one worker', async () => {
      const mockSM = makeMockSessionManager([
        {
          id: 'session-1',
          workers: [{ id: 'default', targetIds: ['target-1', 'target-2'] }],
          pages: {
            'target-1': { url: 'https://example.com', title: 'Example' },
            'target-2': { url: 'https://google.com', title: 'Google' },
          },
        },
      ]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();

      expect(tabs).toHaveLength(2);
      expect(tabs[0]).toMatchObject({
        targetId: 'target-1',
        workerId: 'default',
        sessionId: 'session-1',
        url: 'https://example.com',
        title: 'Example',
      });
      expect(tabs[1]).toMatchObject({
        targetId: 'target-2',
        workerId: 'default',
        sessionId: 'session-1',
        url: 'https://google.com',
        title: 'Google',
      });
    });

    test('returns tabs for multiple sessions and workers', async () => {
      const mockSM = makeMockSessionManager([
        {
          id: 'session-1',
          workers: [
            { id: 'default', targetIds: ['t1'] },
            { id: 'worker-2', targetIds: ['t2', 't3'] },
          ],
          pages: {
            't1': { url: 'https://a.com', title: 'A' },
            't2': { url: 'https://b.com', title: 'B' },
            't3': { url: 'https://c.com', title: 'C' },
          },
        },
        {
          id: 'session-2',
          workers: [{ id: 'default', targetIds: ['t4'] }],
          pages: { 't4': { url: 'https://d.com', title: 'D' } },
        },
      ]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();

      expect(tabs).toHaveLength(4);
      const urls = tabs.map(t => t.url);
      expect(urls).toContain('https://a.com');
      expect(urls).toContain('https://b.com');
      expect(urls).toContain('https://c.com');
      expect(urls).toContain('https://d.com');
    });

    test('falls back gracefully when session manager throws', async () => {
      (getSessionManager as jest.Mock).mockImplementation(() => {
        throw new Error('Not initialized');
      });

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();
      expect(tabs).toEqual([]);
    });

    test('uses about:blank when page.url() returns empty string', async () => {
      const mockSM = makeMockSessionManager([
        {
          id: 'session-1',
          workers: [{ id: 'default', targetIds: ['target-1'] }],
          pages: { 'target-1': { url: '', title: '' } },
        },
      ]);
      // Override the page mock to return empty string for url
      mockSM._pagesByTarget['target-1'].url.mockReturnValue('');
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();

      expect(tabs[0].url).toBe('about:blank');
    });

    test('handles page.title() throwing by using empty string', async () => {
      const mockSM = makeMockSessionManager([
        {
          id: 'session-1',
          workers: [{ id: 'default', targetIds: ['target-1'] }],
          pages: { 'target-1': { url: 'https://example.com', title: 'ignored' } },
        },
      ]);
      mockSM._pagesByTarget['target-1'].title.mockRejectedValue(new Error('page crashed'));
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();

      expect(tabs[0].title).toBe('');
      expect(tabs[0].url).toBe('https://example.com');
    });

    test('handles getPage returning null gracefully', async () => {
      const mockSM = makeMockSessionManager([
        {
          id: 'session-1',
          workers: [{ id: 'default', targetIds: ['target-1'] }],
        },
      ]);
      mockSM.getPage.mockResolvedValue(null);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const { collectTabs } = await import('../../src/tools/session-snapshot');
      const tabs = await collectTabs();

      expect(tabs).toHaveLength(1);
      expect(tabs[0].url).toBe('about:blank');
      expect(tabs[0].title).toBe('');
    });
  });

  // ── File save ────────────────────────────────────────────────────────────

  describe('saveSnapshot', () => {
    test('writes latest.json and history file atomically', async () => {
      const { saveSnapshot, SNAPSHOT_DIR } = await import('../../src/tools/session-snapshot');

      // Mock fs.promises.mkdir and readdir for pruneSnapshots
      jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
      jest.spyOn(fs.promises, 'readdir').mockResolvedValue([] as any);

      const snapshot = {
        version: 1 as const,
        id: 'snap-20240101-120000-abcd',
        timestamp: 1704067200000,
        tabs: [],
        memo: {
          objective: 'Test objective',
          currentStep: 'Step 1',
          nextActions: ['Do X', 'Do Y'],
        },
      };

      await saveSnapshot(snapshot);

      const calls = (writeFileAtomicSafe as jest.Mock).mock.calls;
      const paths = calls.map((c: unknown[]) => c[0] as string);

      expect(paths).toContain(path.join(SNAPSHOT_DIR, 'latest.json'));
      expect(paths).toContain(path.join(SNAPSHOT_DIR, 'snap-20240101-120000-abcd.json'));

      // Both calls should pass the same snapshot object
      expect(calls[0][1]).toEqual(snapshot);
      expect(calls[1][1]).toEqual(snapshot);
    });
  });

  // ── Prune logic ──────────────────────────────────────────────────────────

  describe('pruneSnapshots', () => {
    test('removes oldest snapshots when count exceeds MAX_SNAPSHOTS', async () => {
      const { pruneSnapshots, MAX_SNAPSHOTS, SNAPSHOT_DIR } = await import('../../src/tools/session-snapshot');

      // Generate MAX_SNAPSHOTS + 3 fake snapshot files (sorted lexicographically = chronological)
      const snapFiles: string[] = [];
      for (let i = 0; i < MAX_SNAPSHOTS + 3; i++) {
        snapFiles.push(`snap-2024010${i < 10 ? '0' + i : i}-120000-aaaa.json`);
      }
      snapFiles.sort();

      const unlinkMock = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
      jest.spyOn(fs.promises, 'readdir').mockResolvedValue(snapFiles as any);
      jest.spyOn(fs.promises, 'stat').mockResolvedValue({ mtimeMs: Date.now() } as fs.Stats);

      await pruneSnapshots();

      // Should have deleted the 3 oldest
      expect(unlinkMock).toHaveBeenCalledTimes(3);
      const deletedPaths = unlinkMock.mock.calls.map((c: unknown[]) => c[0] as string);
      for (let i = 0; i < 3; i++) {
        expect(deletedPaths).toContain(path.join(SNAPSHOT_DIR, snapFiles[i]));
      }
    });

    test('removes snapshots older than 30 days', async () => {
      const { pruneSnapshots, SNAPSHOT_DIR } = await import('../../src/tools/session-snapshot');

      const oldFile = 'snap-20200101-000000-aaaa.json';
      const newFile = 'snap-20240101-000000-bbbb.json';

      const unlinkMock = jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
      jest.spyOn(fs.promises, 'readdir').mockResolvedValue([oldFile, newFile] as any);
      jest.spyOn(fs.promises, 'stat').mockImplementation(async (filePath) => {
        const fp = filePath as string;
        if (fp.includes('20200101')) {
          return { mtimeMs: Date.now() - (31 * 24 * 60 * 60 * 1000) } as fs.Stats;
        }
        return { mtimeMs: Date.now() } as fs.Stats;
      });

      await pruneSnapshots();

      const deletedPaths = unlinkMock.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(deletedPaths).toContain(path.join(SNAPSHOT_DIR, oldFile));
      expect(deletedPaths).not.toContain(path.join(SNAPSHOT_DIR, newFile));
    });

    test('handles readdir failure gracefully (best-effort)', async () => {
      const { pruneSnapshots } = await import('../../src/tools/session-snapshot');

      jest.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('ENOENT'));

      // Should not throw
      await expect(pruneSnapshots()).resolves.toBeUndefined();
    });
  });

  // ── Handler integration ──────────────────────────────────────────────────

  describe('handler', () => {
    beforeEach(() => {
      jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
      jest.spyOn(fs.promises, 'readdir').mockResolvedValue([] as any);
    });

    test('creates snapshot with required memo fields and returns correct text', async () => {
      const mockSM = makeMockSessionManager([]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const handler = await getSnapshotHandler();

      const result = await handler('session-1', {
        objective: 'Scrape product data',
        currentStep: 'Navigating to listing page',
        nextActions: ['Extract table rows', 'Follow pagination'],
      }) as { content: Array<{ type: string; text: string }>; _snapshotId: string };

      expect(result.content[0].type).toBe('text');
      const text = result.content[0].text;
      expect(text).toContain('Snapshot saved: snap-');
      expect(text).toContain('Tabs: 0');
      expect(text).toContain('Objective: Scrape product data');
      expect(text).toContain('Step: Navigating to listing page');
      expect(text).toContain('Next: Extract table rows, Follow pagination');
      expect(text).toContain('Use oc_session_resume to restore this context after compaction.');
    });

    test('returns _snapshotId in result matching text', async () => {
      const mockSM = makeMockSessionManager([]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const handler = await getSnapshotHandler();

      const result = await handler('session-1', {
        objective: 'Test',
        currentStep: 'Step 1',
        nextActions: [],
      }) as { content: Array<{ type: string; text: string }>; _snapshotId: string };

      expect(result._snapshotId).toMatch(/^snap-/);
      expect(result.content[0].text).toContain(result._snapshotId);
    });

    test('captures tabs from active sessions', async () => {
      const mockSM = makeMockSessionManager([
        {
          id: 'session-1',
          workers: [{ id: 'default', targetIds: ['t1', 't2'] }],
          pages: {
            't1': { url: 'https://example.com', title: 'Example' },
            't2': { url: 'https://test.com', title: 'Test' },
          },
        },
      ]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const handler = await getSnapshotHandler();

      const result = await handler('session-1', {
        objective: 'Test tabs',
        currentStep: 'Collecting',
        nextActions: [],
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Tabs: 2');
    });

    test('includes optional completedSteps and notes in memo', async () => {
      const mockSM = makeMockSessionManager([]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const handler = await getSnapshotHandler();

      await handler('session-1', {
        objective: 'Full workflow',
        currentStep: 'Phase 2',
        nextActions: ['Action A'],
        completedSteps: ['Phase 1 done', 'Login complete'],
        notes: 'Using staging environment',
        label: 'phase-2-checkpoint',
      });

      // Verify writeFileAtomicSafe received snapshot with all optional fields
      const savedSnapshot = (writeFileAtomicSafe as jest.Mock).mock.calls[0][1];
      expect(savedSnapshot.memo.completedSteps).toEqual(['Phase 1 done', 'Login complete']);
      expect(savedSnapshot.memo.notes).toBe('Using staging environment');
      expect(savedSnapshot.label).toBe('phase-2-checkpoint');
    });

    test('snapshot has correct version, id, and timestamp shape', async () => {
      const mockSM = makeMockSessionManager([]);
      (getSessionManager as jest.Mock).mockReturnValue(mockSM);

      const before = Date.now();
      const handler = await getSnapshotHandler();

      await handler('session-1', {
        objective: 'Verify shape',
        currentStep: 'Step A',
        nextActions: ['Next'],
      });

      const savedSnapshot = (writeFileAtomicSafe as jest.Mock).mock.calls[0][1];
      expect(savedSnapshot.version).toBe(1);
      expect(savedSnapshot.id).toMatch(/^snap-/);
      expect(savedSnapshot.timestamp).toBeGreaterThanOrEqual(before);
      expect(savedSnapshot.timestamp).toBeLessThanOrEqual(Date.now());
    });

    test('works without Chrome connected (tabs = [])', async () => {
      (getSessionManager as jest.Mock).mockImplementation(() => {
        throw new Error('Chrome not connected');
      });

      const handler = await getSnapshotHandler();

      const result = await handler('session-1', {
        objective: 'Fallback test',
        currentStep: 'Step 1',
        nextActions: [],
      }) as { content: Array<{ type: string; text: string }> };

      // Should succeed with empty tabs
      expect(result.content[0].text).toContain('Tabs: 0');
      expect(result.content[0].text).toContain('Snapshot saved:');
    });
  });
});

// Need fs import for spyOn
import * as fs from 'fs';
