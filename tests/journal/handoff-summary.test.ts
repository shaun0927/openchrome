/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHandoffSummary } from '../../src/journal/handoff-summary';
import { JournalEntry, TaskJournal } from '../../src/journal/task-journal';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `handoff-summary-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ts: Date.parse('2026-05-12T10:00:00.000Z'),
    tool: 'navigate',
    sessionId: 'sess-a',
    args: { url: 'https://example.test', token: '[REDACTED]' },
    durationMs: 10,
    ok: true,
    summary: '✓ → https://example.test',
    milestone: true,
    ...overrides,
  };
}

describe('buildHandoffSummary', () => {
  let dir: string;
  let journal: TaskJournal;

  beforeEach(() => {
    dir = tmpDir();
    journal = new TaskJournal({ dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty but valid bounded summary without journal or checkpoint data', () => {
    const summary = buildHandoffSummary(journal, { now: Date.parse('2026-05-12T11:00:00.000Z') });

    expect(summary.schemaVersion).toBe(1);
    expect(summary.completedMilestones).toEqual([]);
    expect(summary.recentFailures).toEqual([]);
    expect(summary.currentState.unavailable).toContain('checkpoint_state');
    expect(summary.currentState.unavailable).toContain('tab_state');
    expect(summary.recommendedRecoveryOptions[0].action).toContain('oc_journal recent');
    expect(JSON.stringify(summary).length).toBeLessThan(5000);
  });

  it('includes ordered milestones and checkpoint pending state', () => {
    journal.record(entry({ ts: Date.parse('2026-05-12T10:00:00.000Z'), summary: '✓ → https://a.test' }));
    journal.record(entry({ ts: Date.parse('2026-05-12T10:02:00.000Z'), tool: 'fill_form', summary: '✓ Fill form (1 fields)' }));

    const summary = buildHandoffSummary(journal, {
      checkpoint: {
        timestamp: Date.parse('2026-05-12T09:59:00.000Z'),
        pendingSteps: ['submit search', 'collect results'],
        currentUrl: 'https://a.test/form',
        tabStates: [{ tabId: 'tab-1', url: 'https://a.test/form', title: 'Form' }],
      },
    });

    expect(summary.currentState.currentUrl).toBe('https://a.test/form');
    expect(summary.currentState.tabs).toHaveLength(1);
    expect(summary.completedMilestones.map(m => m.summary)).toEqual(['✓ → https://a.test', '✓ Fill form (1 fields)']);
    expect(summary.pendingSteps).toEqual(['submit search', 'collect results']);
    expect(summary.recommendedRecoveryOptions.some(r => r.reason.includes('pending steps'))).toBe(true);
  });



  it('surfaces checkpoint completed steps as resume milestones when journal entries are outside checkpoint scope', () => {
    journal.record(entry({ ts: Date.parse('2026-05-12T09:00:00.000Z'), summary: '✓ before checkpoint' }));

    const summary = buildHandoffSummary(journal, {
      sessionId: 'sess-a',
      checkpoint: {
        timestamp: Date.parse('2026-05-12T10:00:00.000Z'),
        completedSteps: ['already completed'],
      },
    });

    expect(summary.completedMilestones.map(m => m.summary)).toEqual(['✓ already completed']);
    expect(summary.completedMilestones[0].tool).toBe('oc_checkpoint');
  });

  it('groups failures by sanitized signature without leaking sensitive values', () => {
    journal.record(entry({
      ok: false,
      tool: 'find',
      summary: '✗ Find "submit"',
      milestone: undefined,
      args: { selector: '#submit', password: '[REDACTED]' },
    }));
    journal.record(entry({
      ts: Date.parse('2026-05-12T10:01:00.000Z'),
      ok: false,
      tool: 'find',
      summary: '✗ Find "submit"',
      milestone: undefined,
      args: { password: '[REDACTED]', selector: '#submit' },
    }));

    const summary = buildHandoffSummary(journal);

    expect(summary.recentFailures).toHaveLength(1);
    expect(summary.recentFailures[0].count).toBe(2);
    expect(summary.recentFailures[0].signature).toContain('[REDACTED]');
    expect(summary.recentFailures[0].signature).not.toContain('hunter2');
    expect(summary.recommendedRecoveryOptions[0].action).toContain('Refresh the DOM snapshot');
  });

  it('scopes by since, checkpoint timestamp, and session id', () => {
    journal.record(entry({ ts: Date.parse('2026-05-12T09:00:00.000Z'), sessionId: 'sess-a', summary: '✓ old' }));
    journal.record(entry({ ts: Date.parse('2026-05-12T10:00:00.000Z'), sessionId: 'sess-b', summary: '✓ other session' }));
    journal.record(entry({ ts: Date.parse('2026-05-12T10:01:00.000Z'), sessionId: 'sess-a', summary: '✓ included' }));

    const summary = buildHandoffSummary(journal, {
      since: Date.parse('2026-05-12T09:30:00.000Z'),
      sessionId: 'sess-a',
      checkpoint: { timestamp: Date.parse('2026-05-12T10:00:30.000Z') },
    });

    expect(summary.completedMilestones.map(m => m.summary)).toEqual(['✓ included']);
    expect(summary.currentState.sessionId).toBe('sess-a');
  });



  it('scopes to caller-provided sessionId stored in sanitized tool args', () => {
    journal.record(entry({ sessionId: 'mcp-default', args: { sessionId: 'logical-session' }, summary: '✓ logical' }));

    const summary = buildHandoffSummary(journal, { sessionId: 'logical-session' });

    expect(summary.currentState.sessionId).toBe('logical-session');
    expect(summary.completedMilestones.map(m => m.sessionId)).toEqual(['logical-session']);
  });

  it('caps large synthetic output deterministically', () => {
    for (let i = 0; i < 50; i += 1) {
      journal.record(entry({
        ts: Date.parse('2026-05-12T10:00:00.000Z') + i,
        ok: i % 2 === 0,
        tool: i % 2 === 0 ? 'navigate' : 'interact',
        args: { selector: `#button-${i}`, token: '[REDACTED]' },
        summary: `${i % 2 === 0 ? '✓' : '✗'} step ${i}`,
        milestone: true,
      }));
    }

    const summary = buildHandoffSummary(journal, {
      checkpoint: { pendingSteps: Array.from({ length: 30 }, (_, i) => `pending ${i}`) },
    });

    expect(summary.completedMilestones).toHaveLength(10);
    expect(summary.recentFailures).toHaveLength(5);
    expect(summary.pendingSteps).toHaveLength(10);
    expect(JSON.stringify(summary).length).toBeLessThan(12000);
  });
});
