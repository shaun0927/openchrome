import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  pickBestEdge,
  matchesExpected,
  runSkill,
  _matchesExpectedRaw,
  type ActionInvocation,
  type ExecutionContext,
  type ToolRouter,
  type SkillIntent,
} from '../../src/skill/executor';
import { SkillGraphStorage, type SkillEdge } from '../../src/skill/storage';
import type { PageSnapshot } from '../../src/skill/state';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oc-exec-'));
}

function emptyEdge(over: Partial<SkillEdge> = {}): SkillEdge {
  return {
    fromState: 'a',
    actionKind: 'click',
    actionArgsNorm: 'x',
    toStateDistribution: [],
    successCount: 0,
    failCount: 0,
    ...over,
  };
}

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    interactives: [{ tagName: 'button', tagPath: 'body>button', role: 'button' }],
    headings: [],
    landmarks: {},
    ...over,
  };
}

describe('matchesExpected — distribution math (#703 v2 rules)', () => {
  test('total < 10, hash present at any count → match', () => {
    expect(_matchesExpectedRaw('A', [{ to_state: 'A', count: 1 }], 0)).toBe(true);
    expect(_matchesExpectedRaw('A', [{ to_state: 'A', count: 1 }, { to_state: 'B', count: 1 }], 0)).toBe(true);
  });

  test('total < 10, hash absent, no failures → match (first observation)', () => {
    expect(_matchesExpectedRaw('NEW', [{ to_state: 'A', count: 5 }], 0)).toBe(true);
  });

  test('total < 10, hash absent, has failures → no match', () => {
    expect(_matchesExpectedRaw('NEW', [{ to_state: 'A', count: 5 }], 1)).toBe(false);
  });

  test('total >= 10, hash count >= 10% → match', () => {
    // 1/10 = 10% exactly → match
    const dist = [
      { to_state: 'A', count: 9 },
      { to_state: 'B', count: 1 },
    ];
    expect(_matchesExpectedRaw('B', dist, 0)).toBe(true);
  });

  test('total >= 10, hash count < 10% → no match', () => {
    // 1/15 = 6.7% < 10%
    const dist = [
      { to_state: 'A', count: 14 },
      { to_state: 'B', count: 1 },
    ];
    expect(_matchesExpectedRaw('B', dist, 0)).toBe(false);
  });

  test('total >= 10, hash absent → no match (no longer "fresh observation")', () => {
    expect(_matchesExpectedRaw('NEW', [{ to_state: 'A', count: 10 }], 0)).toBe(false);
  });

  test('matchesExpected accepts SkillEdge form', () => {
    const edge = emptyEdge({
      toStateDistribution: [{ to_state: 'A', count: 1 }],
    });
    expect(matchesExpected('A', edge)).toBe(true);
  });
});

describe('pickBestEdge — selection', () => {
  test('returns first edge when no allowedKinds filter', () => {
    const edges: SkillEdge[] = [emptyEdge({ actionKind: 'click' }), emptyEdge({ actionKind: 'type' })];
    expect(pickBestEdge(edges, {})?.actionKind).toBe('click');
  });

  test('respects allowedKinds (skips disallowed)', () => {
    const edges: SkillEdge[] = [
      emptyEdge({ actionKind: 'navigate' }),
      emptyEdge({ actionKind: 'click' }),
    ];
    const intent: SkillIntent = { allowedKinds: ['click'] };
    expect(pickBestEdge(edges, intent)?.actionKind).toBe('click');
  });

  test('returns undefined when no edge matches the intent filter', () => {
    const edges: SkillEdge[] = [emptyEdge({ actionKind: 'navigate' })];
    expect(pickBestEdge(edges, { allowedKinds: ['click'] })).toBeUndefined();
  });

  test('returns undefined for empty edge list', () => {
    expect(pickBestEdge([], {})).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Mock router for runSkill scenarios                                  */
/* ------------------------------------------------------------------ */

interface RouterScript {
  /** Action returned by pickFallbackAction. null = no action. */
  fallback?: ActionInvocation | null;
  /** Observed result for runAction(). */
  result?: { ok: boolean; reason?: string };
}

function mockRouter(script: RouterScript = {}): ToolRouter {
  return {
    async pickFallbackAction() {
      return script.fallback ?? null;
    },
    async runAction() {
      return { ok: script.result?.ok ?? true, reason: script.result?.reason };
    },
  };
}

function ctxWithStates(seq: PageSnapshot[]): ExecutionContext {
  let i = 0;
  return {
    async snapshotPageState() {
      const next = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return next;
    },
  };
}

describe('runSkill — graph hit path', () => {
  let root: string;
  let storage: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new SkillGraphStorage('x.com', { rootDir: root });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('uses graph edge when one exists for the current state', async () => {
    // Seed graph: from-hash → action → to-hash with one prior success
    const before = snap({ url: 'https://x.com/a' });
    const after = snap({ url: 'https://x.com/b' });

    // Determine the actual hashes the executor will compute
    const { computeStateHash } = await import('../../src/skill/state');
    const fromHash = computeStateHash(before).hash;
    const toHash = computeStateHash(after).hash;

    storage.upsertNode({ stateHash: fromHash });
    storage.upsertNode({ stateHash: toHash });
    storage.recordOutcome({
      fromState: fromHash,
      actionKind: 'click',
      actionArgsNorm: 'ref:a',
      observedToState: toHash,
      success: true,
    });

    const router = mockRouter({ result: { ok: true } });
    const ctx = ctxWithStates([before, after]);
    const result = await runSkill({ storage, router, ctx, intent: {} });

    expect(result.outcome).toBe('graph_hit');
    expect(result.ok).toBe(true);
    expect(result.matchedExpected).toBe(true);
    expect(result.fromState).toBe(fromHash);
    expect(result.toState).toBe(toHash);
    expect(result.action?.kind).toBe('click');
  });

  test('action runs but lands on unexpected state → reports expected_state_mismatch', async () => {
    const before = snap({ url: 'https://x.com/a' });
    const expected = snap({ url: 'https://x.com/b' });
    const actual = snap({ url: 'https://x.com/c' }); // != expected

    const { computeStateHash } = await import('../../src/skill/state');
    const fromHash = computeStateHash(before).hash;
    const expectedHash = computeStateHash(expected).hash;

    storage.upsertNode({ stateHash: fromHash });
    storage.upsertNode({ stateHash: expectedHash });
    // Seed enough successes to push total >= 10, so absent → no match
    for (let i = 0; i < 11; i++) {
      storage.recordOutcome({
        fromState: fromHash,
        actionKind: 'click',
        actionArgsNorm: 'ref:a',
        observedToState: expectedHash,
        success: true,
      });
    }

    const router = mockRouter({ result: { ok: true } });
    const ctx = ctxWithStates([before, actual]);
    const result = await runSkill({ storage, router, ctx, intent: {} });

    expect(result.outcome).toBe('graph_hit');
    expect(result.ok).toBe(false);
    expect(result.matchedExpected).toBe(false);
    expect(result.reason).toBe('expected_state_mismatch');
  });
});

describe('runSkill — fallback / graph miss path', () => {
  let root: string;
  let storage: SkillGraphStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new SkillGraphStorage('x.com', { rootDir: root });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('graph miss → fallback action succeeds → promotes to graph', async () => {
    const before = snap({ url: 'https://x.com/a' });
    const after = snap({ url: 'https://x.com/b' });

    const { computeStateHash } = await import('../../src/skill/state');
    const fromHash = computeStateHash(before).hash;
    const toHash = computeStateHash(after).hash;

    const router = mockRouter({
      fallback: { kind: 'click', argsNorm: 'ref:fallback', args: { ref: 'a' } },
      result: { ok: true },
    });
    const ctx = ctxWithStates([before, after]);
    const result = await runSkill({ storage, router, ctx, intent: {} });

    expect(result.outcome).toBe('graph_fallback_promoted');
    expect(result.ok).toBe(true);
    expect(result.action?.argsNorm).toBe('ref:fallback');

    // Verify it was actually written to the graph
    const promoted = storage.getEdge({
      fromState: fromHash,
      actionKind: 'click',
      actionArgsNorm: 'ref:fallback',
    });
    expect(promoted).toBeDefined();
    expect(promoted?.successCount).toBe(1);
    expect(promoted?.toStateDistribution).toEqual([{ to_state: toHash, count: 1 }]);
  });

  test('graph miss → no fallback available → returns no_action_available', async () => {
    const ctx = ctxWithStates([snap()]);
    const router = mockRouter({ fallback: null });
    const result = await runSkill({ storage, router, ctx, intent: {} });

    expect(result.outcome).toBe('graph_miss');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_action_available');
  });

  test('graph miss → fallback runs but fails → records negative edge, no promotion', async () => {
    const before = snap({ url: 'https://x.com/a' });
    const after = snap({ url: 'https://x.com/a' }); // unchanged

    const { computeStateHash } = await import('../../src/skill/state');
    const fromHash = computeStateHash(before).hash;

    const router = mockRouter({
      fallback: { kind: 'click', argsNorm: 'ref:bad', args: {} },
      result: { ok: false, reason: 'element_not_found' },
    });
    const ctx = ctxWithStates([before, after]);
    const result = await runSkill({ storage, router, ctx, intent: {} });

    expect(result.outcome).toBe('graph_miss');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('element_not_found');

    const negative = storage.getEdge({
      fromState: fromHash,
      actionKind: 'click',
      actionArgsNorm: 'ref:bad',
    });
    expect(negative).toBeDefined();
    expect(negative?.failCount).toBe(1);
    expect(negative?.successCount).toBe(0);
    // No to_state recorded for failures without observed transition
    expect(negative?.toStateDistribution).toEqual([]);
  });
});
