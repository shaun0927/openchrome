/**
 * Tests for src/core/skill-memory/stats-resolver.ts
 *
 * All assertions use the core-tier SkillRecord shape (flat fields:
 * skillId, successCount, lastUsedAt, etc.) — NOT the pilot-tier
 * frontmatter/sidecar shape used in #766's original branch.
 */
import {
  createAuditLogStatsResolver,
  createInMemoryStatsResolver,
} from '../../../src/core/skill-memory/stats-resolver';
import type { SkillRecord } from '../../../src/core/skill-memory/types';

const NOW = Date.parse('2026-05-08T12:00:00Z');

function rec(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    skillId: 'sk-001',
    domain: 'amazon.com',
    name: 'add-to-cart',
    steps: [],
    contractId: 'amazon.checkout',
    successCount: 5,
    lastUsedAt: NOW,
    frozenSnapshotPath: null,
    ...overrides,
  };
}

function audit(ts: string, tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ ts, tool, args });
}

// ---------------------------------------------------------------------------
// skill_run tallies (keyed by skill_id)
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — skill_run tallies (keyed by skill_id)', () => {
  test('counts successes + failures within window for the matching skill_id', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-02T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-03T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
      // Different skill_id — must NOT count
      audit('2026-05-04T12:00:00Z', 'skill_run', { skill_id: 'sk-OTHER', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(2);
    expect(stats.failuresInWindow).toBe(1);
  });

  test('drops entries older than failWindowMs cutoff', () => {
    const lines = [
      audit('2026-04-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }), // > 30d ago
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('lastRunAt = max ts of skill_run entries for this skill_id (contract_runtime entries are ignored)', () => {
    const lines = [
      // contract_runtime must NOT contribute to lastRunAt
      audit('2026-05-07T03:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'postcondition_violation' }),
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-06T09:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBe(Date.parse('2026-05-06T09:00:00Z'));
  });

  test('contract_runtime entries alone do NOT advance lastRunAt', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      audit('2026-05-08T11:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBeNull();
  });

  test('skill_run for a different skill_id does NOT advance lastRunAt', () => {
    const lines = [
      audit('2026-05-08T11:00:00Z', 'skill_run', { skill_id: 'OTHER' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBeNull();
  });

  test('returns lastRunAt=null and zero tallies when no relevant entries exist', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'unrelated_tool', { whatever: 1 }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBeNull();
    expect(stats.successesInWindow).toBe(0);
    expect(stats.failuresInWindow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — defensive parsing', () => {
  test('skips empty lines', () => {
    const lines = [
      '',
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      '',
      '   ',
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('skips malformed JSON lines without throwing', () => {
    const lines = [
      'not json {{',
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      '} also not json',
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('skips non-`{` lines (defensive against log noise)', () => {
    const lines = [
      '[{not an audit row}]',
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('skips entries with malformed ts', () => {
    const lines = [
      JSON.stringify({ ts: 'not-a-date', tool: 'skill_run', args: { skill_id: 'sk-001', verdict: 'success' } }),
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('numeric ts is also accepted (legacy / extended audit shape)', () => {
    const lines = [
      JSON.stringify({ ts: Date.parse('2026-05-06T12:00:00Z'), tool: 'skill_run', args: { skill_id: 'sk-001', verdict: 'success' } }),
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defaults for deferred fields
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — defaults for deferred fields', () => {
  test('demotesInDoubleDemoteWindow defaults to 0 (history store deferred)', () => {
    const stats = createInMemoryStatsResolver([], { now: () => NOW })(rec());
    expect(stats.demotesInDoubleDemoteWindow).toBe(0);
    expect(stats.hadInterveningPromotion).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File-backed reader smoke test
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — file-backed reader (smoke)', () => {
  test('returns empty stats when audit log path does not exist', () => {
    const resolver = createAuditLogStatsResolver({
      auditLogPath: '/tmp/definitely-not-a-real-audit-log-766.jsonl',
      now: () => NOW,
    });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(0);
    expect(stats.failuresInWindow).toBe(0);
    expect(stats.lastRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lastRunAt window decoupled from failWindowMs
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — lastRunAt window decoupled from failWindowMs (#3 regression)', () => {
  test('lastRunAt is non-null for a skill last run between failWindowMs and statsWindowMs ago', () => {
    const FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const STATS_WINDOW_DAYS = 60;
    // 45 days ago: outside 30d fail window but inside 60d stats window
    const fortyFiveDaysAgo = new Date(NOW - 45 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(fortyFiveDaysAgo, 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: STATS_WINDOW_DAYS,
    });
    const stats = resolver(rec());
    // Outside fail window — no tallies
    expect(stats.successesInWindow).toBe(0);
    expect(stats.failuresInWindow).toBe(0);
    // Inside stats window — lastRunAt must be populated
    expect(stats.lastRunAt).toBe(Date.parse(fortyFiveDaysAgo));
  });

  test('lastRunAt is null when skill_run entry is outside statsWindowMs', () => {
    const sixtyOneDaysAgo = new Date(NOW - 61 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(sixtyOneDaysAgo, 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: 30 * 24 * 60 * 60 * 1000,
      statsWindowDays: 60,
    });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(0);
    expect(stats.lastRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Default stats window covers curator untouched horizon (P1 regression)
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — default stats window covers curator untouched horizon (P1 regression)', () => {
  test('50-day-old skill_run is visible with default options (no statsWindowDays override)', () => {
    const fiftyDaysAgo = new Date(NOW - 50 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [audit(fiftyDaysAgo, 'skill_run', { skill_id: 'sk-001' })];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    expect(resolver(rec()).lastRunAt).toBe(Date.parse(fiftyDaysAgo));
  });

  test('contract_runtime alone yields null even within the default 60-day window', () => {
    const fiftyDaysAgo = new Date(NOW - 50 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(fiftyDaysAgo, 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    expect(resolver(rec()).lastRunAt).toBeNull();
  });

  test('61-day-old skill_run entry is NOT visible with default options', () => {
    const sixtyOneDaysAgo = new Date(NOW - 61 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [audit(sixtyOneDaysAgo, 'skill_run', { skill_id: 'sk-001' })];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    expect(resolver(rec()).lastRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure tally via skill_run verdict (P1 regression)
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — failure tally via skill_run verdict (P1 regression)', () => {
  test('skill_run with verdict=postcondition_violation increments failuresInWindow', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-02T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
      audit('2026-05-03T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(1);
    expect(stats.failuresInWindow).toBe(2);
  });

  test('failuresInWindow stays 0 when only contract_runtime failure events exist', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-02T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'postcondition_violation' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(1);
    expect(stats.failuresInWindow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-window independent of stats-window (P2 regression)
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — fail-window independent of stats-window (P2 regression)', () => {
  test('7-day stats window + 30-day fail window counts same failures as 30-day stats window', () => {
    const FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const fifteenDaysAgo = new Date(NOW - 15 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      // 15 days ago: within fail window (30d), but OUTSIDE a 7-day stats window
      audit(fifteenDaysAgo, 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
    ];

    const narrowStats = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: 7,
    });
    const wideStats = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: 30,
    });

    const sNarrow = narrowStats(rec());
    const sWide = wideStats(rec());

    // Both must report the failure regardless of statsWindowDays
    expect(sNarrow.failuresInWindow).toBe(1);
    expect(sWide.failuresInWindow).toBe(1);

    // Narrow stats window: entry is outside 7d so lastRunAt is null
    expect(sNarrow.lastRunAt).toBeNull();
    // Wide stats window: entry is within 30d so lastRunAt is populated
    expect(sWide.lastRunAt).toBe(Date.parse(fifteenDaysAgo));
  });
});

// ---------------------------------------------------------------------------
// Sibling skill isolation (P1 regression)
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — sibling skill isolation (P1 regression)', () => {
  test('two siblings sharing a contractId report independent success/failure stats', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-A', verdict: 'success', contract_id: 'shared.contract' }),
      audit('2026-05-02T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-A', verdict: 'success', contract_id: 'shared.contract' }),
      audit('2026-05-03T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-A', verdict: 'success', contract_id: 'shared.contract' }),
      audit('2026-05-04T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-B', verdict: 'postcondition_violation', contract_id: 'shared.contract' }),
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-B', verdict: 'postcondition_violation', contract_id: 'shared.contract' }),
      audit('2026-05-06T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-B', verdict: 'postcondition_violation', contract_id: 'shared.contract' }),
      audit('2026-05-07T12:00:00Z', 'skill_run', { skill_id: 'skill-anchor-B', verdict: 'postcondition_violation', contract_id: 'shared.contract' }),
      audit('2026-05-08T10:00:00Z', 'skill_run', { skill_id: 'skill-anchor-B', verdict: 'postcondition_violation', contract_id: 'shared.contract' }),
    ];

    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });

    const recA: SkillRecord = rec({ skillId: 'skill-anchor-A', contractId: 'shared.contract' });
    const recB: SkillRecord = rec({ skillId: 'skill-anchor-B', contractId: 'shared.contract' });

    const statsA = resolver(recA);
    const statsB = resolver(recB);

    // Skill A: 3 successes, 0 failures — must not be contaminated by B's failures
    expect(statsA.successesInWindow).toBe(3);
    expect(statsA.failuresInWindow).toBe(0);

    // Skill B: 0 successes, 5 failures — must not be contaminated by A's successes
    expect(statsB.successesInWindow).toBe(0);
    expect(statsB.failuresInWindow).toBe(5);
  });

  test('sibling with no skill_run entries returns lastRunAt=null regardless of sibling activity', () => {
    const recentTs = '2026-05-07T10:00:00Z';
    const lines = [
      audit(recentTs, 'skill_run', { skill_id: 'sibling-A', verdict: 'success', contract_id: 'shared.contract' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });

    const recA = rec({ skillId: 'sibling-A', contractId: 'shared.contract' });
    const recB = rec({ skillId: 'sibling-B', contractId: 'shared.contract' });

    // Sibling A has activity — must report it
    expect(resolver(recA).lastRunAt).toBe(Date.parse(recentTs));
    // Sibling B has no skill_run entries — must be null
    expect(resolver(recB).lastRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lazy index: built once, shared across calls
// ---------------------------------------------------------------------------

describe('createAuditLogStatsResolver — lazy index (built once)', () => {
  test('calling resolver twice uses the same index (readLines called once)', () => {
    let callCount = 0;
    const lines = [
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const resolver = createAuditLogStatsResolver({
      auditLogPath: '<in-memory>',
      now: () => NOW,
      readLines: () => {
        callCount++;
        return lines;
      },
    });

    resolver(rec());
    resolver(rec());

    expect(callCount).toBe(1);
  });
});
