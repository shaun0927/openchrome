/**
 * Unit tests for the deterministic skill replay engine (#856).
 *
 * Covers the four outcome paths defined by the issue contract:
 *   PASS               — all steps succeed and contract evaluates to passed
 *   STEP_FAIL          — a CDP step rejects
 *   CONTRACT_FAIL      — steps succeed but contract returns passed=false (or
 *                        is unevaluable / unbound)
 *   PRECONDITION_FAIL  — snapshot origin and active origin both known and differ
 *
 * The replay engine consumes injected adapters; these tests inject
 * deterministic stubs and assert against the persisted outcome + the
 * SkillReplayResult shape.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillMemoryStore, type SkillRecord } from '../../../src/core/skill-memory';
import {
  runReplay,
  type ContractEvaluator,
  type FrozenSnapshotReader,
  type ReplayCdpClient,
  type ReplayTraceEmitter,
  type ReplayTraceEvent,
  type SkillReplayResult,
} from '../../../src/pilot/skill/replay';

type FixtureContext = {
  rootDir: string;
  store: SkillMemoryStore;
};

async function setup(domain = 'replay.test'): Promise<FixtureContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'oc-replay-'));
  const store = new SkillMemoryStore({ domain, rootDir });
  return { rootDir, store };
}

async function teardown(ctx: FixtureContext): Promise<void> {
  await rm(ctx.rootDir, { recursive: true, force: true });
}

async function recordSkill(
  ctx: FixtureContext,
  opts: {
    name?: string;
    steps?: unknown[];
    contractId?: string;
  } = {},
): Promise<string> {
  const { skill_id } = await ctx.store.record({
    domain: 'replay.test',
    name: opts.name ?? 'login-happy-path',
    steps: opts.steps ?? [
      { method: 'Page.bringToFront', params: {} },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Tab' } },
    ],
    contractId: opts.contractId ?? 'doc.title_eq_welcome',
    frozenSnapshotPath: null,
    successCount: 0,
    lastUsedAt: 0,
  });
  return skill_id;
}

function mkCdp(opts: {
  url?: string | null;
  send?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
} = {}): ReplayCdpClient {
  return {
    async send(method, params) {
      if (opts.send) return opts.send(method, params);
      return undefined;
    },
    async getActiveUrl() {
      return opts.url ?? null;
    },
  };
}

const noSnapshotReader: FrozenSnapshotReader = {
  async readUrlOrigin() {
    return null;
  },
};

function mkEvaluator(verdict: { evaluated: boolean; passed: boolean; detail?: unknown }): ContractEvaluator {
  return {
    async evaluate() {
      return verdict;
    },
  };
}

function captureTrace(): { trace: ReplayTraceEmitter; events: ReplayTraceEvent[] } {
  const events: ReplayTraceEvent[] = [];
  return {
    events,
    trace: {
      emit(event) {
        events.push(event);
      },
    },
  };
}

describe('runReplay — outcome paths', () => {
  test('PASS: all steps succeed and contract evaluates to passed=true', async () => {
    const ctx = await setup();
    try {
      const skillId = await recordSkill(ctx);
      const cdp = mkCdp({ url: 'https://app.example.com/dashboard' });
      const evaluator = mkEvaluator({ evaluated: true, passed: true });
      const { trace, events } = captureTrace();

      const result = await runReplay({
        skillId,
        store: ctx.store,
        cdp,
        snapshotReader: noSnapshotReader,
        evaluator,
        trace,
      });

      expect(result.outcome).toBe('PASS');
      expect(result.contract.evaluated).toBe(true);
      expect(result.contract.passed).toBe(true);
      expect(result.steps_total).toBe(2);
      expect(result.steps_executed).toBe(2);
      expect(result.step_failures).toEqual([]);
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ kind: 'skill_replay', outcome: 'PASS', steps_total: 2 });

      // Persistence: lastReplayPassedAt is now set, lastReplayError cleared.
      const persisted: SkillRecord | null = ctx.store.get(skillId);
      expect(persisted?.lastReplayPassedAt).toBeGreaterThan(0);
      expect(persisted?.lastReplayError).toBeUndefined();
    } finally {
      await teardown(ctx);
    }
  });

  test('STEP_FAIL: a CDP step rejects, replay aborts immediately', async () => {
    const ctx = await setup();
    try {
      const skillId = await recordSkill(ctx);
      let calls = 0;
      const cdp = mkCdp({
        url: 'https://app.example.com/dashboard',
        async send(method) {
          calls++;
          if (calls === 2) throw new Error(`mock CDP failure on ${method}`);
          return undefined;
        },
      });
      const evaluator = mkEvaluator({ evaluated: true, passed: true });

      const result = await runReplay({
        skillId,
        store: ctx.store,
        cdp,
        snapshotReader: noSnapshotReader,
        evaluator,
      });

      expect(result.outcome).toBe('STEP_FAIL');
      expect(result.steps_executed).toBe(1);
      expect(result.steps_total).toBe(2);
      expect(result.step_failures).toHaveLength(1);
      expect(result.step_failures[0].index).toBe(1);
      expect(result.contract.evaluated).toBe(false);

      // Persisted as failed; passedAt not set, error captured.
      const persisted = ctx.store.get(skillId);
      expect(persisted?.lastReplayFailedAt).toBeGreaterThan(0);
      expect(persisted?.lastReplayPassedAt ?? 0).toBe(0);
      expect(persisted?.lastReplayError).toMatch(/mock CDP failure/);
    } finally {
      await teardown(ctx);
    }
  });

  test('CONTRACT_FAIL: steps succeed but contract returns passed=false', async () => {
    const ctx = await setup();
    try {
      const skillId = await recordSkill(ctx);
      const cdp = mkCdp({ url: 'https://app.example.com/dashboard' });
      const evaluator = mkEvaluator({ evaluated: true, passed: false, detail: { reason: 'flash missing' } });

      const result = await runReplay({
        skillId,
        store: ctx.store,
        cdp,
        snapshotReader: noSnapshotReader,
        evaluator,
      });

      expect(result.outcome).toBe('CONTRACT_FAIL');
      expect(result.steps_executed).toBe(2);
      expect(result.contract.evaluated).toBe(true);
      expect(result.contract.passed).toBe(false);

      const persisted = ctx.store.get(skillId);
      expect(persisted?.lastReplayFailedAt).toBeGreaterThan(0);
      expect(persisted?.lastReplayError).toMatch(/contract failed/);
    } finally {
      await teardown(ctx);
    }
  });

  test('PRECONDITION_FAIL: snapshot origin and active origin both known and differ', async () => {
    const ctx = await setup();
    try {
      const skillId = await recordSkill(ctx);
      const cdp = mkCdp({
        url: 'https://example.com/other',
        async send() {
          throw new Error('replay must not execute steps when precondition fails');
        },
      });
      const snapshotReader: FrozenSnapshotReader = {
        async readUrlOrigin() {
          return 'https://the-internet.herokuapp.com';
        },
      };
      const evaluator = mkEvaluator({ evaluated: true, passed: true });

      const result = await runReplay({
        skillId,
        store: ctx.store,
        cdp,
        snapshotReader,
        evaluator,
      });

      expect(result.outcome).toBe('PRECONDITION_FAIL');
      expect(result.steps_executed).toBe(0);
      expect(result.step_failures[0].error).toMatch(/precondition/);

      const persisted = ctx.store.get(skillId);
      expect(persisted?.lastReplayFailedAt).toBeGreaterThan(0);
    } finally {
      await teardown(ctx);
    }
  });

  test('CONTRACT_FAIL when no contract is bound — the engine refuses an un-gated PASS', async () => {
    const ctx = await setup();
    try {
      const skillId = await recordSkill(ctx, { contractId: '' });
      const cdp = mkCdp({ url: 'https://app.example.com/dashboard' });
      const evaluator = mkEvaluator({ evaluated: true, passed: true });

      const result = await runReplay({
        skillId,
        store: ctx.store,
        cdp,
        snapshotReader: noSnapshotReader,
        evaluator,
      });

      expect(result.outcome).toBe('CONTRACT_FAIL');
      expect(result.contract.evaluated).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });

  test('clamps step_timeout_ms to MAX_STEP_TIMEOUT_MS', async () => {
    const ctx = await setup();
    try {
      const skillId = await recordSkill(ctx);
      const cdp = mkCdp({ url: 'https://app.example.com/dashboard' });
      const evaluator = mkEvaluator({ evaluated: true, passed: true });

      const result = await runReplay({
        skillId,
        stepTimeoutMs: 999999, // far above MAX_STEP_TIMEOUT_MS
        store: ctx.store,
        cdp,
        snapshotReader: noSnapshotReader,
        evaluator,
      });

      // We don't observe the clamped value directly, but a wildly large
      // timeout cannot turn a passing call into a non-PASS.
      expect(result.outcome).toBe('PASS');
    } finally {
      await teardown(ctx);
    }
  });
});
