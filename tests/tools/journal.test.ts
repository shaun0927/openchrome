/// <reference types="jest" />
/**
 * Tests for oc_journal tool
 */

import { parseSince } from '../../src/tools/journal';

// ─── Mock getTaskJournal ────────────────────────────────────────────────────

const mockGetRecent = jest.fn();
const mockGetSummary = jest.fn();
const mockCreateEntry = jest.fn();
const mockRecord = jest.fn();

jest.mock('../../src/journal/task-journal', () => ({
  getTaskJournal: jest.fn(() => ({
    getRecent: mockGetRecent,
    getSummary: mockGetSummary,
    createEntry: mockCreateEntry,
    record: mockRecord,
    init: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock session manager and chrome launcher to satisfy MCPServer constructor
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
import { registerJournalTool } from '../../src/tools/journal';
import { JournalEntry } from '../../src/journal/task-journal';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: Date.now(),
    tool: 'navigate',
    sessionId: 'default',
    args: { url: 'https://example.com' },
    durationMs: 123,
    ok: true,
    summary: '✓ → https://example.com',
    milestone: true,
    ...overrides,
  };
}

// ─── parseSince ──────────────────────────────────────────────────────────────

describe('parseSince', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns undefined for undefined input', () => {
    expect(parseSince(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(parseSince('')).toBeUndefined();
  });

  test('parses relative minutes "30m"', () => {
    const result = parseSince('30m');
    const expected = Date.now() - 30 * 60000;
    expect(result).toBe(expected);
  });

  test('parses relative hours "1h"', () => {
    const result = parseSince('1h');
    const expected = Date.now() - 1 * 3600000;
    expect(result).toBe(expected);
  });

  test('parses relative days "2d"', () => {
    const result = parseSince('2d');
    const expected = Date.now() - 2 * 86400000;
    expect(result).toBe(expected);
  });

  test('parses ISO timestamp', () => {
    const iso = '2024-01-15T10:00:00.000Z';
    const result = parseSince(iso);
    expect(result).toBe(new Date(iso).getTime());
  });

  test('returns undefined for invalid string', () => {
    expect(parseSince('invalid')).toBeUndefined();
  });
});

// ─── Handler tests ───────────────────────────────────────────────────────────

describe('oc_journal tool', () => {
  let server: MCPServer;
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = new MCPServer();
    registerJournalTool(server);
    handler = server.getToolHandler('oc_journal')!;
    expect(handler).toBeDefined();
  });

  // ─── action=summary ──────────────────────────────────────────────────────

  describe('action=summary', () => {
    test('returns formatted summary with milestones', async () => {
      const now = Date.now();
      const milestone = makeEntry({ ts: now - 60000, milestone: true, summary: '✓ → https://example.com' });

      mockGetSummary.mockReturnValue({
        total: 10,
        succeeded: 8,
        failed: 2,
        toolCounts: { navigate: 5, read_page: 3, interact: 2 },
        milestones: [milestone],
        period: { start: now - 300000, end: now },
      });

      const result = await handler('default', { action: 'summary' });
      expect(result.content).toHaveLength(1);
      const text: string = result.content[0].text;

      expect(text).toContain('SESSION JOURNAL SUMMARY');
      expect(text).toContain('Total calls: 10 (8 success, 2 failed)');
      expect(text).toContain('Milestones:');
      expect(text).toContain('✓ → https://example.com');
      expect(text).toContain('navigate(5)');
      expect(text).toContain('Failure rate: 20.0%');
    });

    test('returns summary with no milestones or tool counts', async () => {
      const now = Date.now();
      mockGetSummary.mockReturnValue({
        total: 0,
        succeeded: 0,
        failed: 0,
        toolCounts: {},
        milestones: [],
        period: { start: now, end: now },
      });

      const result = await handler('default', { action: 'summary' });
      const text: string = result.content[0].text;

      expect(text).toContain('SESSION JOURNAL SUMMARY');
      expect(text).toContain('Total calls: 0');
      expect(text).not.toContain('Milestones:');
      expect(text).not.toContain('Tools:');
      expect(text).not.toContain('Failure rate:');
    });

    test('passes since filter to getSummary', async () => {
      const now = Date.now();
      mockGetSummary.mockReturnValue({
        total: 5,
        succeeded: 5,
        failed: 0,
        toolCounts: { navigate: 5 },
        milestones: [],
        period: { start: now - 3600000, end: now },
      });

      await handler('default', { action: 'summary', since: '1h' });

      expect(mockGetSummary).toHaveBeenCalledWith(
        expect.objectContaining({ since: expect.any(Number) })
      );
    });
  });

  // ─── action=recent ───────────────────────────────────────────────────────

  describe('action=recent', () => {
    test('returns formatted recent entries', async () => {
      const now = Date.now();
      const entries = [
        makeEntry({ ts: now - 5000, tool: 'navigate', durationMs: 200, milestone: true }),
        makeEntry({ ts: now - 3000, tool: 'read_page', durationMs: 50, ok: true, summary: '✓ Read page', milestone: undefined }),
      ];
      mockGetRecent.mockReturnValue(entries);

      const result = await handler('default', { action: 'recent' });
      const text: string = result.content[0].text;
      const lines = text.split('\n');

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('200ms');
      expect(lines[0]).toContain('★'); // milestone marker
      expect(lines[1]).toContain('50ms');
      expect(lines[1]).not.toContain('★');
    });

    test('uses default count of 20', async () => {
      mockGetRecent.mockReturnValue([makeEntry()]);
      await handler('default', { action: 'recent' });
      expect(mockGetRecent).toHaveBeenCalledWith(20);
    });

    test('respects count parameter (clamped to 1-100)', async () => {
      mockGetRecent.mockReturnValue([makeEntry()]);
      await handler('default', { action: 'recent', count: 50 });
      expect(mockGetRecent).toHaveBeenCalledWith(50);
    });

    test('clamps count to max 100', async () => {
      mockGetRecent.mockReturnValue([makeEntry()]);
      await handler('default', { action: 'recent', count: 999 });
      expect(mockGetRecent).toHaveBeenCalledWith(100);
    });

    test('clamps count to min 1', async () => {
      mockGetRecent.mockReturnValue([makeEntry()]);
      await handler('default', { action: 'recent', count: -5 });
      expect(mockGetRecent).toHaveBeenCalledWith(1);
    });

    test('filters by tool name', async () => {
      const now = Date.now();
      const entries = [
        makeEntry({ tool: 'navigate', summary: '✓ → https://a.com' }),
        makeEntry({ tool: 'read_page', summary: '✓ Read page' }),
        makeEntry({ tool: 'navigate', summary: '✓ → https://b.com' }),
      ];
      mockGetRecent.mockReturnValue(entries);

      const result = await handler('default', { action: 'recent', tool: 'navigate' });
      const text: string = result.content[0].text;

      expect(text).toContain('https://a.com');
      expect(text).toContain('https://b.com');
      expect(text).not.toContain('Read page');
    });

    test('filters by since timestamp', async () => {
      const now = Date.now();
      const oldEntry = makeEntry({ ts: now - 7200000, summary: '✓ Old entry' });
      const newEntry = makeEntry({ ts: now - 1000, summary: '✓ New entry' });
      mockGetRecent.mockReturnValue([oldEntry, newEntry]);

      // Filter to last 1 hour
      const result = await handler('default', { action: 'recent', since: '1h' });
      const text: string = result.content[0].text;

      expect(text).toContain('New entry');
      expect(text).not.toContain('Old entry');
    });

    test('returns no entries message when list is empty', async () => {
      mockGetRecent.mockReturnValue([]);

      const result = await handler('default', { action: 'recent' });
      expect(result.content[0].text).toBe('No journal entries found.');
    });

    test('returns no entries message when filter eliminates all entries', async () => {
      const entries = [makeEntry({ tool: 'navigate' })];
      mockGetRecent.mockReturnValue(entries);

      const result = await handler('default', { action: 'recent', tool: 'read_page' });
      expect(result.content[0].text).toBe('No journal entries found.');
    });
  });

  // ─── unknown action ──────────────────────────────────────────────────────

  describe('unknown action', () => {
    test('returns error message for unknown action', async () => {
      mockGetSummary.mockReturnValue({
        total: 0, succeeded: 0, failed: 0, toolCounts: {}, milestones: [],
        period: { start: Date.now(), end: Date.now() },
      });
      mockGetRecent.mockReturnValue([]);

      const result = await handler('default', { action: 'invalid' });
      expect(result.content[0].text).toContain('Unknown action: invalid');
      expect(result.content[0].text).toContain('"summary"');
      expect(result.content[0].text).toContain('"recent"');
    });
  });

  // ─── registration ────────────────────────────────────────────────────────

  test('tool is registered with correct name', () => {
    expect(server.getToolNames()).toContain('oc_journal');
  });
});
