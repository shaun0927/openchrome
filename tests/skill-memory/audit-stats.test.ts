import {
  createAuditLogStatsResolver,
  createInMemoryStatsResolver,
} from '../../src/skill-memory/audit-stats';
import type { SkillRecord } from '../../src/skill-memory/types';

const NOW = Date.parse('2026-05-08T12:00:00Z');

function rec(over: Partial<SkillRecord['frontmatter']> = {}): SkillRecord {
  return {
    skill_id: 'sk-001',
    filePath: '/tmp/sk-001.md',
    sidecarPath: '/tmp/sk-001.json',
    frontmatter: {
      schema_version: 1,
      name: 'sk',
      domain: 'amazon.com',
      intent: 'i',
      status: 'promoted',
      verified_runs: 5,
      last_verified_at: '2026-05-08T12:00:00Z',
      contract_ref: 'amazon.checkout',
      graph_node_anchor: 'a1b2',
      author: 'agent',
      ...over,
    },
    sidecar: {
      schema_version: 1,
      skill_id: 'sk-001',
      graph_node_anchor: 'a1b2',
      contract_id: 'amazon.checkout',
      runs: { count: 5, window_start: '2026-04-08T12:00:00Z', recent: [] },
    },
  };
}

function audit(ts: string, tool: string, args: Record<string, unknown>): string {
  return JSON.stringify({ ts, tool, args });
}

describe('createAuditLogStatsResolver — skill_run tallies (keyed by skill_id)', () => {
  test('counts successes + failures within window for the matching skill_id', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-02T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      audit('2026-05-03T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
      // Different skill_id sharing the same contract — must NOT count
      audit('2026-05-04T12:00:00Z', 'skill_run', { skill_id: 'sk-OTHER', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(2);
    expect(stats.failuresInWindow).toBe(1);
  });

  test('drops entries older than the failWindowMs cutoff', () => {
    const lines = [
      audit('2026-04-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }), // > 30d ago
      audit('2026-05-05T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('lastRunAt = max ts of any matching contract_runtime entry', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      audit('2026-05-07T03:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'postcondition_violation' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBe(Date.parse('2026-05-07T03:00:00Z'));
  });

  test('skill_run audit events advance lastRunAt when present', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      audit('2026-05-08T11:00:00Z', 'skill_run', { skill_id: 'sk-001' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBe(Date.parse('2026-05-08T11:00:00Z'));
  });

  test('skill_run for a different skill_id does NOT advance lastRunAt', () => {
    const lines = [
      audit('2026-05-08T11:00:00Z', 'skill_run', { skill_id: 'OTHER' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBeNull();
  });

  test('returns lastRunAt=null when no relevant entries exist', () => {
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

describe('createAuditLogStatsResolver — defaults for deferred fields', () => {
  test('demotesInDoubleDemoteWindow defaults to 0 (history store deferred)', () => {
    const stats = createInMemoryStatsResolver([], { now: () => NOW })(rec());
    expect(stats.demotesInDoubleDemoteWindow).toBe(0);
    expect(stats.hadInterveningPromotion).toBe(false);
  });
});

describe('createAuditLogStatsResolver — file-backed reader (smoke)', () => {
  test('returns empty stats when audit log path does not exist', () => {
    const resolver = createAuditLogStatsResolver({
      auditLogPath: '/tmp/definitely-not-a-real-audit-log.jsonl',
      now: () => NOW,
    });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(0);
    expect(stats.failuresInWindow).toBe(0);
    expect(stats.lastRunAt).toBeNull();
  });
});

describe('createAuditLogStatsResolver — lastRunAt window decoupled from failWindowMs (#3 regression)', () => {
  // A skill last used 45 days ago is within the 60-day untouched-archive
  // threshold but OUTSIDE the 30-day failWindowMs. With the old code the
  // outer loop bailed out at `ts < cutoff` so lastRunAt stayed null and
  // the curator would archive the skill as "untouched". After the fix,
  // lastRunAt is tracked over the full statsWindowMs (default 30d here
  // overridden to 60d) independently of the fail window.
  test('lastRunAt is non-null for a skill last run between failWindowMs and statsWindowMs ago', () => {
    const FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const STATS_WINDOW_DAYS = 60; // 60 days — wider than failWindowMs
    // Entry at 45 days ago: outside the 30d fail window but inside the 60d stats window.
    const fortyFiveDaysAgo = new Date(NOW - 45 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(fortyFiveDaysAgo, 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: STATS_WINDOW_DAYS,
    });
    const stats = resolver(rec());
    // The entry is outside failWindowMs so tallies must be zero.
    expect(stats.successesInWindow).toBe(0);
    expect(stats.failuresInWindow).toBe(0);
    // But lastRunAt must be populated — the skill was touched 45 days ago.
    expect(stats.lastRunAt).toBe(Date.parse(fortyFiveDaysAgo));
  });

  test('lastRunAt is null when entry is outside both failWindowMs and statsWindowMs', () => {
    const FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const STATS_WINDOW_DAYS = 60;
    // Entry at 61 days ago: outside both windows.
    const sixtyOneDaysAgo = new Date(NOW - 61 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(sixtyOneDaysAgo, 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: STATS_WINDOW_DAYS,
    });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(0);
    expect(stats.lastRunAt).toBeNull();
  });
});

describe('createAuditLogStatsResolver — default stats window covers curator untouched horizon (P1 regression)', () => {
  // PR #766 round-3 follow-up: the old default statsWindowDays was 30, but the
  // curator's untouched-archive horizon is 60 days. A skill last used 31-60 days
  // ago was invisible to the default resolver (lastRunAt = null) and got archived
  // as "untouched" even though it had recent activity within the curator's policy.
  // The fix raises the default to 60 to match the curator's horizon exactly.
  test('50-day-old skill_run is visible with default options (no statsWindowDays override)', () => {
    const fiftyDaysAgo = new Date(NOW - 50 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(fiftyDaysAgo, 'skill_run', { skill_id: 'sk-001' }),
    ];
    // Deliberately use NO statsWindowDays override — the default must be wide enough.
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBe(Date.parse(fiftyDaysAgo));
  });

  test('50-day-old contract_runtime entry is visible with default options', () => {
    const fiftyDaysAgo = new Date(NOW - 50 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(fiftyDaysAgo, 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBe(Date.parse(fiftyDaysAgo));
  });

  test('61-day-old entry is NOT visible with default options (outside horizon)', () => {
    const sixtyOneDaysAgo = new Date(NOW - 61 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      audit(sixtyOneDaysAgo, 'skill_run', { skill_id: 'sk-001' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.lastRunAt).toBeNull();
  });
});

describe('createAuditLogStatsResolver — failure tally via skill_run verdict (P1 regression)', () => {
  // Approach A: extractor now emits skill_run with verdict='postcondition_violation'
  // from recordFailedRun(). This test verifies audit-stats tallies those events so
  // that failuresInWindow > 0 and Pass 1 demotion in runCurator can fire.
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

  test('failuresInWindow stays 0 when no failure skill_run events exist', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'skill_run', { skill_id: 'sk-001', verdict: 'success' }),
      // contract_runtime failure does NOT increment failuresInWindow (skill_run is required)
      audit('2026-05-02T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'postcondition_violation' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(1);
    expect(stats.failuresInWindow).toBe(0);
  });
});

describe('createAuditLogStatsResolver — fail-window independent of stats-window (P2 regression)', () => {
  // Reducing statsWindowDays below failWindowMs must NOT truncate failure counts.
  // A 7-day stats window with a 30-day fail window must count failures identically
  // to a 30-day stats window with a 30-day fail window.
  test('7-day stats window + 30-day fail window counts same failures as 30-day stats window', () => {
    const FAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const fifteenDaysAgo = new Date(NOW - 15 * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      // 15 days ago: within fail window (30d), but OUTSIDE a 7-day stats window
      audit(fifteenDaysAgo, 'skill_run', { skill_id: 'sk-001', verdict: 'postcondition_violation' }),
    ];

    const resolverNarrowStats = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: 7,
    });
    const resolverWideStats = createInMemoryStatsResolver(lines, {
      now: () => NOW,
      failWindowMs: FAIL_WINDOW_MS,
      statsWindowDays: 30,
    });

    const statsNarrow = resolverNarrowStats(rec());
    const statsWide = resolverWideStats(rec());

    // Both must report the failure regardless of statsWindowDays
    expect(statsNarrow.failuresInWindow).toBe(1);
    expect(statsWide.failuresInWindow).toBe(1);

    // With the narrow stats window, lastRunAt should be null (entry is outside 7d)
    expect(statsNarrow.lastRunAt).toBeNull();
    // With the wide stats window, lastRunAt is populated
    expect(statsWide.lastRunAt).toBe(Date.parse(fifteenDaysAgo));
  });
});

describe('createAuditLogStatsResolver — sibling skill isolation (P1 regression)', () => {
  // Two skills share the same contract_id but differ in graph_node_anchor,
  // so they have different skill_ids. Before the fix, both would receive
  // the combined success+failure tallies of the shared contract. After the
  // fix, verdict tallies are keyed by skill_id so each sibling reports only
  // its own outcomes.
  test('two siblings sharing a contract_id report independent success/failure stats', () => {
    // Skill A: skill_id 'skill-anchor-A', 3 successes
    // Skill B: skill_id 'skill-anchor-B', 5 failures
    // Both share contract_id 'shared.contract'
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

    // Build SkillRecord for sibling A
    const recA: SkillRecord = {
      skill_id: 'skill-anchor-A',
      filePath: '/tmp/skill-anchor-A.md',
      sidecarPath: '/tmp/skill-anchor-A.json',
      frontmatter: {
        schema_version: 1,
        name: 'skill-a',
        domain: 'example.com',
        intent: 'sibling A',
        status: 'promoted',
        verified_runs: 3,
        last_verified_at: '2026-05-03T12:00:00Z',
        contract_ref: 'txn-a',
        graph_node_anchor: 'anchor-A',
        author: 'agent',
      },
      sidecar: {
        schema_version: 1,
        skill_id: 'skill-anchor-A',
        graph_node_anchor: 'anchor-A',
        contract_id: 'shared.contract',
        runs: { count: 3, window_start: '2026-04-08T12:00:00Z', recent: [] },
      },
    };

    // Build SkillRecord for sibling B
    const recB: SkillRecord = {
      skill_id: 'skill-anchor-B',
      filePath: '/tmp/skill-anchor-B.md',
      sidecarPath: '/tmp/skill-anchor-B.json',
      frontmatter: {
        schema_version: 1,
        name: 'skill-b',
        domain: 'example.com',
        intent: 'sibling B',
        status: 'promoted',
        verified_runs: 0,
        last_verified_at: '2026-05-08T10:00:00Z',
        contract_ref: 'txn-b',
        graph_node_anchor: 'anchor-B',
        author: 'agent',
      },
      sidecar: {
        schema_version: 1,
        skill_id: 'skill-anchor-B',
        graph_node_anchor: 'anchor-B',
        contract_id: 'shared.contract',
        runs: { count: 0, window_start: '2026-04-08T12:00:00Z', recent: [] },
      },
    };

    const statsA = resolver(recA);
    const statsB = resolver(recB);

    // Skill A: 3 successes, 0 failures — must not be contaminated by B's failures
    expect(statsA.successesInWindow).toBe(3);
    expect(statsA.failuresInWindow).toBe(0);

    // Skill B: 0 successes, 5 failures — must not be contaminated by A's successes
    expect(statsB.successesInWindow).toBe(0);
    expect(statsB.failuresInWindow).toBe(5);
  });
});
