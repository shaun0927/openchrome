/**
 * Tests for marginal-utility tracker wire-up into applyToolCallToTask
 * (#1428 wire-up follow-up).
 *
 * These tests pin the contract that every tool call appends a
 * cost_curve entry and that oc_assert / oc_checkpoint signals move
 * p_success deterministically.
 */
import { applyToolCallToTask, initialCounters } from '../../../src/core/task-ledger';
import type { TaskMeta, RecordedToolCall } from '../../../src/core/task-ledger';

function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    task_id: 'a'.repeat(16),
    kind: 'browser',
    status: 'in_progress',
    pid: 1,
    created_at: 0,
    args_summary: {},
    counters: initialCounters(),
    ...overrides,
  } as TaskMeta;
}

function call(overrides: Partial<RecordedToolCall> = {}): RecordedToolCall {
  return {
    ts: 1_700_000_000,
    tool: 'read_page',
    sessionId: 's',
    args: {},
    durationMs: 10,
    ok: true,
    ...overrides,
  };
}

describe('applyToolCallToTask — marginal-utility wire-up (#1428)', () => {
  it('appends one cost_curve entry per tool call', () => {
    let meta = makeMeta();
    expect(meta.cost_curve ?? []).toEqual([]);
    meta = applyToolCallToTask(meta, call({ ts: 1 }));
    expect(meta.cost_curve).toHaveLength(1);
    expect(meta.cost_curve![0].step).toBe(1);
    meta = applyToolCallToTask(meta, call({ ts: 2 }));
    expect(meta.cost_curve).toHaveLength(2);
    expect(meta.cost_curve![1].step).toBe(2);
  });

  it('persists _mu_state between calls', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call({ ts: 1 }));
    expect(meta._mu_state).toBeDefined();
    expect(meta._mu_state!.totalSteps).toBe(1);
    meta = applyToolCallToTask(meta, call({ ts: 2 }));
    expect(meta._mu_state!.totalSteps).toBe(2);
  });

  it('counts an oc_assert success as a positive assert signal', () => {
    let meta = makeMeta();
    // Two read_page calls to establish a baseline.
    meta = applyToolCallToTask(meta, call({ ts: 1 }));
    meta = applyToolCallToTask(meta, call({ ts: 2 }));
    const baseP = meta._mu_state!.lastP;
    meta = applyToolCallToTask(meta, call({ ts: 3, tool: 'oc_assert', ok: true }));
    // oc_assert pass = strict 1.0 contribution → p_success increases.
    expect(meta._mu_state!.lastP).toBeGreaterThan(baseP);
  });

  it('counts an oc_assert failure as a negative assert signal', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call({ ts: 1, tool: 'oc_assert', ok: true }));
    const peak = meta._mu_state!.lastP;
    meta = applyToolCallToTask(meta, call({ ts: 2, tool: 'oc_assert', ok: false }));
    expect(meta._mu_state!.lastP).toBeLessThan(peak);
    expect(meta.cost_curve![1].delta).toBeLessThan(0);
  });

  it('treats oc_checkpoint success as a checkpoint advance', () => {
    let meta = makeMeta();
    meta = applyToolCallToTask(meta, call({ ts: 1, tool: 'navigate' }));
    const baseP = meta._mu_state!.lastP;
    meta = applyToolCallToTask(meta, call({ ts: 2, tool: 'oc_checkpoint', ok: true }));
    expect(meta._mu_state!.lastP).toBeGreaterThan(baseP);
  });

  it('caps cost_curve at COST_CURVE_MAX_ENTRIES (500) to bound TaskMeta growth', () => {
    let meta = makeMeta();
    for (let i = 0; i < 600; i++) {
      meta = applyToolCallToTask(meta, call({ ts: i }));
    }
    expect(meta.cost_curve!.length).toBe(500);
    // Newest survive, oldest evicted.
    expect(meta.cost_curve![meta.cost_curve!.length - 1].step).toBe(600);
  });
});
