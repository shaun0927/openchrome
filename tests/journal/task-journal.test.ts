/**
 * Tests for TaskJournal — core MCP tool call tracking module.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskJournal, JournalEntry, getTaskJournal } from '../../src/journal/task-journal';

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `task-journal-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

describe('TaskJournal', () => {
  let dir: string;
  let journal: TaskJournal;

  beforeEach(() => {
    dir = makeTmpDir();
    journal = new TaskJournal({ dir });
  });

  afterEach(() => {
    cleanupDir(dir);
  });

  // -------------------------------------------------------------------------
  // createEntry()
  // -------------------------------------------------------------------------
  describe('createEntry()', () => {
    it('returns an entry with correct base fields', () => {
      const before = Date.now();
      const entry = journal.createEntry('navigate', 'sess-1', { url: 'https://example.com' }, 120, true);
      const after = Date.now();

      expect(entry.tool).toBe('navigate');
      expect(entry.sessionId).toBe('sess-1');
      expect(entry.durationMs).toBe(120);
      expect(entry.ok).toBe(true);
      expect(entry.ts).toBeGreaterThanOrEqual(before);
      expect(entry.ts).toBeLessThanOrEqual(after);
    });

    it('extracts tabId from args when present', () => {
      const entry = journal.createEntry('read_page', 'sess-2', { tabId: 'tab-42' }, 50, true);
      expect(entry.tabId).toBe('tab-42');
    });

    it('leaves tabId undefined when not in args', () => {
      const entry = journal.createEntry('read_page', 'sess-2', {}, 50, true);
      expect(entry.tabId).toBeUndefined();
    });

    it('marks navigate as a milestone', () => {
      const entry = journal.createEntry('navigate', 'sess-1', { url: 'https://example.com' }, 10, true);
      expect(entry.milestone).toBe(true);
    });

    it('marks fill_form as a milestone', () => {
      const entry = journal.createEntry('fill_form', 'sess-1', {}, 10, true);
      expect(entry.milestone).toBe(true);
    });

    it('marks tabs_create as a milestone', () => {
      const entry = journal.createEntry('tabs_create', 'sess-1', {}, 10, true);
      expect(entry.milestone).toBe(true);
    });

    it('marks tabs_close as a milestone', () => {
      const entry = journal.createEntry('tabs_close', 'sess-1', {}, 10, true);
      expect(entry.milestone).toBe(true);
    });

    it('does not mark non-milestone tools', () => {
      const entry = journal.createEntry('read_page', 'sess-1', {}, 10, true);
      expect(entry.milestone).toBeUndefined();
    });

    it('includes sanitized args in the entry', () => {
      const entry = journal.createEntry('navigate', 'sess-1', { url: 'https://example.com', password: 'secret' }, 10, true);
      expect(entry.args.url).toBe('https://example.com');
      expect(entry.args.password).toBe('[REDACTED]');
    });
  });

  // -------------------------------------------------------------------------
  // sanitizeArgs()
  // -------------------------------------------------------------------------
  describe('sanitizeArgs()', () => {
    it('redacts entire args for REDACT_TOOLS (cookies)', () => {
      const result = journal.sanitizeArgs('cookies', { name: 'session', value: 'abc123' });
      expect(result).toEqual({ _redacted: true });
    });

    it('redacts entire args for REDACT_TOOLS (http_auth)', () => {
      const result = journal.sanitizeArgs('http_auth', { username: 'admin', password: 'pass' });
      expect(result).toEqual({ _redacted: true });
    });

    it('redacts keys matching REDACT_KEYS pattern — password', () => {
      const result = journal.sanitizeArgs('navigate', { password: 'hunter2' });
      expect(result.password).toBe('[REDACTED]');
    });

    it('redacts keys matching REDACT_KEYS pattern — token', () => {
      const result = journal.sanitizeArgs('navigate', { token: 'abc' });
      expect(result.token).toBe('[REDACTED]');
    });

    it('redacts keys matching REDACT_KEYS pattern — secret', () => {
      const result = journal.sanitizeArgs('navigate', { secret: 'xyz' });
      expect(result.secret).toBe('[REDACTED]');
    });

    it('redacts keys matching REDACT_KEYS pattern — credential', () => {
      const result = journal.sanitizeArgs('navigate', { credential: 'cred' });
      expect(result.credential).toBe('[REDACTED]');
    });

    it('redacts keys matching REDACT_KEYS pattern — api_key', () => {
      const result = journal.sanitizeArgs('navigate', { api_key: 'key123' });
      expect(result.api_key).toBe('[REDACTED]');
    });

    it('redacts keys matching REDACT_KEYS pattern — apiKey (camelCase)', () => {
      const result = journal.sanitizeArgs('navigate', { apiKey: 'key456' });
      expect(result.apiKey).toBe('[REDACTED]');
    });

    it('passes through non-sensitive keys unchanged', () => {
      const result = journal.sanitizeArgs('navigate', { url: 'https://example.com', tabId: 'tab-1' });
      expect(result.url).toBe('https://example.com');
      expect(result.tabId).toBe('tab-1');
    });

    it('handles empty args', () => {
      const result = journal.sanitizeArgs('navigate', {});
      expect(result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // generateSummary()
  // -------------------------------------------------------------------------
  describe('generateSummary()', () => {
    it('formats navigate with url', () => {
      expect(journal.generateSummary('navigate', { url: 'https://example.com' }, true))
        .toBe('✓ → https://example.com');
    });

    it('formats navigate without url', () => {
      expect(journal.generateSummary('navigate', {}, true)).toBe('✓ → unknown');
    });

    it('formats read_page', () => {
      expect(journal.generateSummary('read_page', {}, true)).toBe('✓ Read page');
    });

    it('formats interact with description', () => {
      expect(journal.generateSummary('interact', { description: 'Submit button' }, true))
        .toBe('✓ Click "Submit button"');
    });

    it('formats interact with selector fallback', () => {
      expect(journal.generateSummary('interact', { selector: '#btn' }, true))
        .toBe('✓ Click "#btn"');
    });

    it('formats fill_form with fields count', () => {
      expect(journal.generateSummary('fill_form', { fields: { email: 'a@b.com', name: 'Alice' } }, true))
        .toBe('✓ Fill form (2 fields)');
    });

    it('formats fill_form without fields', () => {
      expect(journal.generateSummary('fill_form', {}, true)).toBe('✓ Fill form (0 fields)');
    });

    it('formats javascript_tool', () => {
      expect(journal.generateSummary('javascript_tool', { code: 'document.title' }, true))
        .toBe('✓ JS eval');
    });

    it('formats tabs_create with url', () => {
      expect(journal.generateSummary('tabs_create', { url: 'https://example.com' }, true))
        .toBe('✓ New tab → https://example.com');
    });

    it('formats tabs_create without url', () => {
      expect(journal.generateSummary('tabs_create', {}, true)).toBe('✓ New tab');
    });

    it('formats tabs_close', () => {
      expect(journal.generateSummary('tabs_close', {}, true)).toBe('✓ Close tab');
    });

    it('formats oc_stop', () => {
      expect(journal.generateSummary('oc_stop', {}, true)).toBe('✓ Stop OpenChrome');
    });

    it('formats oc_session_snapshot', () => {
      expect(journal.generateSummary('oc_session_snapshot', {}, true)).toBe('✓ Snapshot saved');
    });

    it('formats workflow_init', () => {
      expect(journal.generateSummary('workflow_init', {}, true)).toBe('✓ Workflow started');
    });

    it('uses default format for unknown tools', () => {
      expect(journal.generateSummary('some_unknown_tool', {}, true)).toBe('✓ some_unknown_tool');
    });

    it('uses ✗ for failed calls', () => {
      expect(journal.generateSummary('navigate', { url: 'https://example.com' }, false))
        .toBe('✗ → https://example.com');
    });

    it('uses ✗ for failed read_page', () => {
      expect(journal.generateSummary('read_page', {}, false)).toBe('✗ Read page');
    });
  });

  // -------------------------------------------------------------------------
  // record() + getRecent()
  // -------------------------------------------------------------------------
  describe('record() + getRecent()', () => {
    it('writes entries that can be read back', () => {
      const entry = journal.createEntry('navigate', 'sess-1', { url: 'https://example.com' }, 100, true);
      journal.record(entry);

      const recent = journal.getRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].tool).toBe('navigate');
      expect(recent[0].sessionId).toBe('sess-1');
    });

    it('writes multiple entries and reads them all back', () => {
      for (let i = 0; i < 5; i++) {
        const entry = journal.createEntry('read_page', `sess-${i}`, {}, 50, true);
        journal.record(entry);
      }

      const recent = journal.getRecent(10);
      expect(recent).toHaveLength(5);
    });

    it('respects count limit in getRecent()', () => {
      for (let i = 0; i < 10; i++) {
        journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));
      }
      const recent = journal.getRecent(3);
      expect(recent).toHaveLength(3);
    });

    it('returns last N entries (most recent)', () => {
      const urls = ['https://a.com', 'https://b.com', 'https://c.com'];
      for (const url of urls) {
        journal.record(journal.createEntry('navigate', 'sess', { url }, 10, true));
      }

      const recent = journal.getRecent(2);
      expect(recent).toHaveLength(2);
      // Should be the last 2
      expect(recent[0].args.url).toBe('https://b.com');
      expect(recent[1].args.url).toBe('https://c.com');
    });

    it('returns empty array when no entries written', () => {
      expect(journal.getRecent(10)).toEqual([]);
    });

    it('does not throw when journal dir does not exist yet', () => {
      const nonExistentDir = path.join(os.tmpdir(), `no-such-${Date.now()}`);
      const j = new TaskJournal({ dir: nonExistentDir });
      expect(() => j.getRecent(5)).not.toThrow();
    });

    it('record() does not throw when dir does not exist', () => {
      const nonExistentDir = path.join(os.tmpdir(), `no-such-${Date.now()}`);
      const j = new TaskJournal({ dir: nonExistentDir });
      const entry = j.createEntry('navigate', 'sess', { url: 'https://example.com' }, 10, true);
      // Should not throw (best-effort)
      expect(() => j.record(entry)).not.toThrow();
    });

    it('skips malformed JSONL lines', () => {
      // Write a valid entry, then a corrupt line, then another valid entry
      const entry1 = journal.createEntry('navigate', 'sess', { url: 'https://a.com' }, 10, true);
      const entry2 = journal.createEntry('read_page', 'sess', {}, 10, true);
      journal.record(entry1);

      // Manually inject a corrupt line
      const today = new Date().toISOString().slice(0, 10);
      const filepath = path.join(dir, `journal-${today}.jsonl`);
      fs.appendFileSync(filepath, 'NOT_VALID_JSON\n');

      journal.record(entry2);

      const recent = journal.getRecent(10);
      expect(recent).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getMilestones()
  // -------------------------------------------------------------------------
  describe('getMilestones()', () => {
    it('returns only milestone entries', () => {
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://a.com' }, 10, true));
      journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));
      journal.record(journal.createEntry('fill_form', 'sess', { fields: {} }, 10, true));

      const milestones = journal.getMilestones();
      expect(milestones.every(e => e.milestone)).toBe(true);
      expect(milestones.map(e => e.tool)).toEqual(expect.arrayContaining(['navigate', 'fill_form']));
      expect(milestones.map(e => e.tool)).not.toContain('read_page');
    });

    it('filters by since timestamp', () => {
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://old.com' }, 10, true));

      const checkpoint = Date.now();

      // Small delay to ensure ts difference
      const futureTs = checkpoint + 1;
      const newEntry = journal.createEntry('tabs_create', 'sess', {}, 10, true);
      // Override ts to be clearly after checkpoint
      const laterEntry: JournalEntry = { ...newEntry, ts: futureTs };
      journal.record(laterEntry);

      const milestones = journal.getMilestones({ since: checkpoint });
      expect(milestones).toHaveLength(1);
      expect(milestones[0].tool).toBe('tabs_create');
    });

    it('respects limit option', () => {
      for (let i = 0; i < 10; i++) {
        journal.record(journal.createEntry('navigate', 'sess', { url: `https://site${i}.com` }, 10, true));
      }
      const milestones = journal.getMilestones({ limit: 3 });
      expect(milestones).toHaveLength(3);
    });

    it('returns empty array when no milestones exist', () => {
      journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));
      expect(journal.getMilestones()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getSummary()
  // -------------------------------------------------------------------------
  describe('getSummary()', () => {
    it('returns correct total, succeeded, failed counts', () => {
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://a.com' }, 10, true));
      journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://b.com' }, 10, false));

      const summary = journal.getSummary();
      expect(summary.total).toBe(3);
      expect(summary.succeeded).toBe(2);
      expect(summary.failed).toBe(1);
    });

    it('returns correct toolCounts', () => {
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://a.com' }, 10, true));
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://b.com' }, 10, true));
      journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));

      const summary = journal.getSummary();
      expect(summary.toolCounts['navigate']).toBe(2);
      expect(summary.toolCounts['read_page']).toBe(1);
    });

    it('includes milestones in summary', () => {
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://a.com' }, 10, true));
      journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));

      const summary = journal.getSummary();
      expect(summary.milestones.map(e => e.tool)).toContain('navigate');
      expect(summary.milestones.map(e => e.tool)).not.toContain('read_page');
    });

    it('returns period with start and end timestamps', () => {
      const before = Date.now();
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://a.com' }, 10, true));
      journal.record(journal.createEntry('read_page', 'sess', {}, 10, true));
      const after = Date.now();

      const summary = journal.getSummary();
      expect(summary.period.start).toBeGreaterThanOrEqual(before);
      expect(summary.period.end).toBeLessThanOrEqual(after);
      expect(summary.period.end).toBeGreaterThanOrEqual(summary.period.start);
    });

    it('filters by since timestamp', () => {
      journal.record(journal.createEntry('navigate', 'sess', { url: 'https://old.com' }, 10, true));

      const checkpoint = Date.now();

      const laterEntry: JournalEntry = {
        ...journal.createEntry('read_page', 'sess', {}, 10, true),
        ts: checkpoint + 1,
      };
      journal.record(laterEntry);

      const summary = journal.getSummary({ since: checkpoint });
      expect(summary.total).toBe(1);
      expect(summary.toolCounts['read_page']).toBe(1);
    });

    it('returns zeros when no entries exist', () => {
      const summary = journal.getSummary();
      expect(summary.total).toBe(0);
      expect(summary.succeeded).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.toolCounts).toEqual({});
      expect(summary.milestones).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // pruneOldFiles() via init()
  // -------------------------------------------------------------------------
  describe('pruneOldFiles() via init()', () => {
    it('deletes files older than maxAgeDays', async () => {
      const j = new TaskJournal({ dir, maxAgeDays: 3 });

      // Create an old file (10 days ago)
      const oldDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      const oldFile = path.join(dir, `journal-${oldDate}.jsonl`);
      fs.writeFileSync(oldFile, '{"ts":1,"tool":"navigate","sessionId":"s","args":{},"durationMs":1,"ok":true,"summary":"x"}\n');

      // Create a recent file (1 day ago)
      const recentDate = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10);
      const recentFile = path.join(dir, `journal-${recentDate}.jsonl`);
      fs.writeFileSync(recentFile, '{"ts":2,"tool":"read_page","sessionId":"s","args":{},"durationMs":1,"ok":true,"summary":"y"}\n');

      await j.init();

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('does not delete files within maxAgeDays', async () => {
      const j = new TaskJournal({ dir, maxAgeDays: 7 });

      // Create a file 2 days ago (within 7-day window)
      const recentDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      const recentFile = path.join(dir, `journal-${recentDate}.jsonl`);
      fs.writeFileSync(recentFile, '{"ts":1,"tool":"navigate","sessionId":"s","args":{},"durationMs":1,"ok":true,"summary":"x"}\n');

      await j.init();

      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('ignores non-journal files in the directory', async () => {
      const j = new TaskJournal({ dir, maxAgeDays: 1 });

      const otherFile = path.join(dir, 'some-other-file.txt');
      fs.writeFileSync(otherFile, 'data');

      await j.init();

      expect(fs.existsSync(otherFile)).toBe(true);
    });

    it('creates journal directory if it does not exist', async () => {
      const newDir = path.join(os.tmpdir(), `journal-init-test-${Math.random().toString(36).slice(2)}`);
      const j = new TaskJournal({ dir: newDir });
      try {
        await j.init();
        expect(fs.existsSync(newDir)).toBe(true);
      } finally {
        cleanupDir(newDir);
      }
    });
  });

  // -------------------------------------------------------------------------
  // getTaskJournal() singleton
  // -------------------------------------------------------------------------
  describe('getTaskJournal()', () => {
    it('returns the same instance on repeated calls', () => {
      const a = getTaskJournal();
      const b = getTaskJournal();
      expect(a).toBe(b);
    });

    it('returns a TaskJournal instance', () => {
      expect(getTaskJournal()).toBeInstanceOf(TaskJournal);
    });
  });
});
