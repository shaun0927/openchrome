/**
 * Tests for `createSidecarStatsResolver` — the replacement for
 * `noopStatsResolver` that the curator runner now uses by default.
 */

import { createSidecarStatsResolver } from '../../../src/pilot/curator/index.js';
import type { SkillRecord } from '../../../src/pilot/curator/index.js';

const DAY = 24 * 60 * 60 * 1000;

function mkRecord(recent: Array<{ txn_id: string; ok: boolean; ts: number }>): SkillRecord {
  return {
    skill_id: 'abc123',
    filePath: '/tmp/nope.md',
    sidecarPath: '/tmp/nope.json',
    frontmatter: {
      schema_version: 1,
      name: 'test',
      domain: 'example.com',
      intent: 'test',
      status: 'promoted',
      verified_runs: 1,
      last_verified_at: '2025-01-01T00:00:00Z',
      contract_ref: 't-x',
      graph_node_anchor: 'anchor',
      author: 'agent',
    },
    sidecar: {
      schema_version: 1,
      skill_id: 'abc123',
      graph_node_anchor: 'anchor',
      contract_id: 'cart.add',
      runs: {
        count: 0,
        window_start: '2025-01-01T00:00:00Z',
        recent,
      },
    },
  };
}

describe('createSidecarStatsResolver', () => {
  it('returns zeros for an empty sidecar', () => {
    const now = 1_700_000_000_000;
    const resolve = createSidecarStatsResolver({ now: () => now });
    const stats = resolve(mkRecord([]));
    expect(stats.successesInWindow).toBe(0);
    expect(stats.failuresInWindow).toBe(0);
    expect(stats.lastRunAt).toBeNull();
    expect(stats.demotesInDoubleDemoteWindow).toBe(0);
  });

  it('counts successes and failures inside the default 30-day window', () => {
    const now = 1_700_000_000_000;
    const resolve = createSidecarStatsResolver({ now: () => now });
    const stats = resolve(
      mkRecord([
        { txn_id: 's1', ok: true, ts: now - 1 * DAY },
        { txn_id: 's2', ok: true, ts: now - 2 * DAY },
        { txn_id: 'f1', ok: false, ts: now - 3 * DAY },
        { txn_id: 'f2', ok: false, ts: now - 4 * DAY },
        { txn_id: 'f3', ok: false, ts: now - 5 * DAY },
      ]),
    );
    expect(stats.successesInWindow).toBe(2);
    expect(stats.failuresInWindow).toBe(3);
    expect(stats.lastRunAt).toBe(now - 1 * DAY);
  });

  it('excludes entries older than the window', () => {
    const now = 1_700_000_000_000;
    const resolve = createSidecarStatsResolver({ now: () => now });
    const stats = resolve(
      mkRecord([
        { txn_id: 'old-success', ok: true, ts: now - 40 * DAY },
        { txn_id: 'old-failure', ok: false, ts: now - 45 * DAY },
        { txn_id: 'fresh', ok: true, ts: now - 1 * DAY },
      ]),
    );
    expect(stats.successesInWindow).toBe(1);
    expect(stats.failuresInWindow).toBe(0);
    expect(stats.lastRunAt).toBe(now - 1 * DAY);
  });

  it('respects an explicit windowMs argument', () => {
    const now = 1_700_000_000_000;
    const resolve = createSidecarStatsResolver({ now: () => now });
    const rec = mkRecord([
      { txn_id: 's-10d', ok: true, ts: now - 10 * DAY },
      { txn_id: 's-2d', ok: true, ts: now - 2 * DAY },
    ]);
    expect(resolve(rec, 7 * DAY).successesInWindow).toBe(1);
    expect(resolve(rec, 14 * DAY).successesInWindow).toBe(2);
  });

  it('ignores malformed entries instead of crashing', () => {
    const now = 1_700_000_000_000;
    const resolve = createSidecarStatsResolver({ now: () => now });
    const stats = resolve(
      mkRecord([
        { txn_id: 'good', ok: true, ts: now - 1 * DAY },
        { txn_id: 'no-ts', ok: true, ts: NaN as unknown as number },
        { txn_id: 'no-ok', ok: 'maybe' as unknown as boolean, ts: now - 1 * DAY },
      ]),
    );
    expect(stats.successesInWindow).toBe(1);
    expect(stats.failuresInWindow).toBe(0);
    expect(stats.lastRunAt).toBe(now - 1 * DAY);
  });

  it('always reports demotesInDoubleDemoteWindow = 0 (documented limitation)', () => {
    const now = 1_700_000_000_000;
    const resolve = createSidecarStatsResolver({ now: () => now });
    const stats = resolve(mkRecord([{ txn_id: 'x', ok: true, ts: now }]));
    expect(stats.demotesInDoubleDemoteWindow).toBe(0);
  });
});
