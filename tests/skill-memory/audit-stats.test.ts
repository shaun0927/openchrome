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

describe('createAuditLogStatsResolver — contract_runtime tallies', () => {
  test('counts successes + failures within window for the matching contract_id', () => {
    const lines = [
      audit('2026-05-01T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      audit('2026-05-02T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      audit('2026-05-03T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'postcondition_violation' }),
      // Different contract — must NOT count
      audit('2026-05-04T12:00:00Z', 'contract_runtime', { contract_id: 'other.thing', verdict: 'success' }),
    ];
    const resolver = createInMemoryStatsResolver(lines, { now: () => NOW });
    const stats = resolver(rec());
    expect(stats.successesInWindow).toBe(2);
    expect(stats.failuresInWindow).toBe(1);
  });

  test('drops entries older than the failWindowMs cutoff', () => {
    const lines = [
      audit('2026-04-01T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }), // > 30d ago
      audit('2026-05-05T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
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
      audit('2026-05-05T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      '',
      '   ',
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('skips malformed JSON lines without throwing', () => {
    const lines = [
      'not json {{',
      audit('2026-05-05T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
      '} also not json',
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('skips non-`{` lines (defensive against log noise)', () => {
    const lines = [
      '[{not an audit row}]',
      audit('2026-05-05T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('skips entries with malformed ts', () => {
    const lines = [
      JSON.stringify({ ts: 'not-a-date', tool: 'contract_runtime', args: { contract_id: 'amazon.checkout', verdict: 'success' } }),
      audit('2026-05-05T12:00:00Z', 'contract_runtime', { contract_id: 'amazon.checkout', verdict: 'success' }),
    ];
    const stats = createInMemoryStatsResolver(lines, { now: () => NOW })(rec());
    expect(stats.successesInWindow).toBe(1);
  });

  test('numeric ts is also accepted (legacy / extended audit shape)', () => {
    const lines = [
      JSON.stringify({ ts: Date.parse('2026-05-06T12:00:00Z'), tool: 'contract_runtime', args: { contract_id: 'amazon.checkout', verdict: 'success' } }),
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
