import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  pickBestEdge,
  matchesExpected,
  runSkill,
  replayArgs,
  encodeReplayArgs,
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

describe('replayArgs / encodeReplayArgs — lossless action payload', () => {
  test('JSON round-trip preserves structured args', () => {
    const args = { ref: 'submit', count: 2, nested: { ok: true } };
    const encoded = encodeReplayArgs(args);
    expect(encoded).toBe(JSON.stringify(args));
    expect(replayArgs(emptyEdge({ actionArgsReplay: encoded }))).toEqual(args);
  });

  test('replayArgs prefers actionArgsReplay over the canonical identity', () => {
    const args = { ref: 'a', clickCount: 3 };
    const edge = emptyEdge({
      actionArgsNorm: 'ref:a',
      actionArgsReplay: JSON.stringify(args),
    });
    // If we leaned on actionArgsNorm we'd get the raw string "ref:a".
    expect(replayArgs(edge)).toEqual(args);
  });

  test('replayArgs falls back to actionArgsNorm for legacy edges (no replay payload)', () => {
    // Pre-v2 edges may carry JSON in actionArgsNorm; honour it when no
    // separate replay payload was stored.
    const edge = emptyEdge({ actionArgsNorm: '{"ref":"legacy"}' });
    expect(replayArgs(edge)).toEqual({ ref: 'legacy' });
  });

  test('replayArgs falls back to the raw norm string for non-JSON legacy identities', () => {
    const edge = emptyEdge({ actionArgsNorm: 'ref:plain' });
    expect(replayArgs(edge)).toBe('ref:plain');
  });

  test('encodeReplayArgs returns undefined for un-stringifiable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(encodeReplayArgs(circular)).toBeUndefined();
  });

  test('encodeReplayArgs rejects silently lossy JSON serialization', () => {
    // JSON.stringify happily mutates these — the resulting payload would
    // execute against a different action shape than what worked. We
    // refuse to store such payloads so graph_hit falls back cleanly.
    expect(encodeReplayArgs({ x: Infinity })).toBeUndefined();
    expect(encodeReplayArgs({ x: -Infinity })).toBeUndefined();
    expect(encodeReplayArgs({ x: Number.NaN })).toBeUndefined();
    expect(encodeReplayArgs({ x: undefined })).toBeUndefined();
    expect(encodeReplayArgs({ x: () => 1 })).toBeUndefined();
    expect(encodeReplayArgs(new Date('2026-01-01'))).toBeUndefined();
    // Top-level undefined / function value: JSON.stringify returns
    // undefined → no payload to store.
    expect(encodeReplayArgs(undefined)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    expect(encodeReplayArgs(() => {})).toBeUndefined();
  });

  test('encodeReplayArgs accepts plain JSON-safe inputs', () => {
    // Sanity-check the happy path is unchanged after the round-trip
    // tightening.
    expect(encodeReplayArgs(null)).toBe('null');
    expect(encodeReplayArgs(0)).toBe('0');
    expect(encodeReplayArgs('text')).toBe('"text"');
    expect(encodeReplayArgs([1, 2, 3])).toBe('[1,2,3]');
    expect(encodeReplayArgs({ a: 'b', c: [true, false] })).toBe(
      '{"a":"b","c":[true,false]}',
    );
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

  test('promoted edge stores lossless action_args_replay → graph_hit replays structured args', async () => {
    const before = snap({ url: 'https://x.com/a' });
    const after = snap({ url: 'https://x.com/b' });

    const { computeStateHash } = await import('../../src/skill/state');
    const fromHash = computeStateHash(before).hash;

    const structuredArgs = { ref: 'submit-button', clickCount: 1 };
    // Promote the edge by running fallback once with structured args. The
    // canonical identity uses the non-JSON `ref:*` form (so parseArgs would
    // hand back a raw string), but the structured payload is what the
    // router needs on replay.
    const promotedAction: ActionInvocation = {
      kind: 'click',
      argsNorm: 'ref:submit-button',
      args: structuredArgs,
    };
    let runActionSawArgs: unknown = null;
    const promoteRouter: ToolRouter = {
      async pickFallbackAction() {
        return promotedAction;
      },
      async runAction(action) {
        runActionSawArgs = action.args;
        return { ok: true };
      },
    };
    await runSkill({
      storage,
      router: promoteRouter,
      ctx: ctxWithStates([before, after]),
      intent: {},
    });
    expect(runActionSawArgs).toEqual(structuredArgs);

    // Now revisit `before` — the executor must hit the graph and replay the
    // structured args, NOT the canonical `ref:submit-button` string.
    runActionSawArgs = null;
    const replayRouter: ToolRouter = {
      async pickFallbackAction() {
        // Fail loudly if the executor falls back instead of hitting the graph.
        return null;
      },
      async runAction(action) {
        runActionSawArgs = action.args;
        return { ok: true };
      },
    };
    const result = await runSkill({
      storage,
      router: replayRouter,
      ctx: ctxWithStates([before, after]),
      intent: {},
    });

    expect(result.outcome).toBe('graph_hit');
    expect(result.ok).toBe(true);
    expect(runActionSawArgs).toEqual(structuredArgs);

    const stored = storage.getEdge({
      fromState: fromHash,
      actionKind: 'click',
      actionArgsNorm: 'ref:submit-button',
    });
    expect(stored?.actionArgsReplay).toBe(JSON.stringify(structuredArgs));
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
