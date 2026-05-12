/**
 * replay.ts unit tests (issue #889).
 *
 * Tests use injected fakes for the tab resolver, step runner, and
 * contract assertion so the suite has no dependency on the live
 * session manager or contract runtime. Coverage:
 *   - happy path returns { success, contract_id }
 *   - domain mismatch → { code: 'skill_domain_mismatch' }
 *   - blocklist → same code
 *   - postcondition failure → { code: 'skill_postcondition_failed' }
 *   - known-stale contract → { code: 'skill_stale' }
 *   - step failure surfaces the step index
 *   - malformed steps → { code: 'skill_unsupported_step' / 'skill_invalid_steps' }
 *   - no active tab → { code: 'skill_no_active_tab' }
 */

import { runReplay } from '../../../src/pilot/dynamic-skills/replay';
import type {
  ActionStepResult,
  CurrentTabInfo,
  ReplayActionStep,
  ReplayHandlerOpts,
} from '../../../src/pilot/dynamic-skills/replay';
import type { SkillRecord } from '../../../src/core/skill-memory/types';

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    skillId: 'a1b2c3d4',
    domain: 'example.com',
    name: 'login',
    steps: {
      parameters: [],
      actions: [
        { kind: 'navigate', url: 'https://example.com/login' },
        { kind: 'fill', selector: '#user', valueParam: 'username' },
        { kind: 'click', selector: 'button[type=submit]' },
      ],
    },
    contractId: 'ctr_login_success',
    successCount: 0,
    lastUsedAt: 0,
    frozenSnapshotPath: null,
    ...overrides,
  };
}

function tab(url: string = 'https://example.com/'): CurrentTabInfo {
  return { url, tabId: 'tab-1' };
}

function makeOpts(overrides: Partial<ReplayHandlerOpts> = {}): ReplayHandlerOpts {
  return {
    resolveCurrentTab: async () => tab(),
    runStep: async () => ({ ok: true }),
    assertContract: async () => ({ pass: true }),
    ...overrides,
  };
}

describe('runReplay — happy path', () => {
  test('returns { success: true, contract_id } and runs every step', async () => {
    const calls: ReplayActionStep[] = [];
    const opts = makeOpts({
      runStep: async (_tab, step) => {
        calls.push(step);
        return { ok: true };
      },
    });
    const out = await runReplay(makeSkill(), { username: 'demo' }, opts);
    expect(out).toEqual({ success: true, contract_id: 'ctr_login_success' });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ kind: 'navigate', url: 'https://example.com/login' });
  });

  test('forwards evidence_handle on success when contract supplies one', async () => {
    const opts = makeOpts({
      assertContract: async () => ({ pass: true, evidenceHandle: 'ev-xyz' }),
    });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out).toEqual({
      success: true,
      contract_id: 'ctr_login_success',
      evidence_handle: 'ev-xyz',
    });
  });
});

describe('runReplay — domain enforcement', () => {
  test('refuses when current tab host does not match skill domain', async () => {
    const opts = makeOpts({
      resolveCurrentTab: async () => tab('https://elsewhere.test/'),
    });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.code).toBe('skill_domain_mismatch');
  });

  test('refuses when tab URL cannot be parsed as a host', async () => {
    const opts = makeOpts({ resolveCurrentTab: async () => tab('not-a-url') });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.code).toBe('skill_domain_mismatch');
  });

  test('refuses when no active tab is available', async () => {
    const opts = makeOpts({ resolveCurrentTab: async () => null });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.code).toBe('skill_no_active_tab');
  });
});

describe('runReplay — contract enforcement', () => {
  test('returns skill_postcondition_failed when contract.pass=false', async () => {
    const opts = makeOpts({
      assertContract: async () => ({ pass: false, reason: 'form did not submit', evidenceHandle: 'ev-1' }),
    });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.code).toBe('skill_postcondition_failed');
      expect(out.message).toBe('form did not submit');
      expect(out.evidence_handle).toBe('ev-1');
    }
  });

  test('returns skill_stale when contract.stale=true', async () => {
    const opts = makeOpts({
      assertContract: async () => ({ pass: false, stale: true, reason: 'form changed' }),
    });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.code).toBe('skill_stale');
      expect(out.message).toBe('form changed');
    }
  });
});

describe('runReplay — step failures', () => {
  test('returns skill_step_failed with step_index on first failure', async () => {
    let calls = 0;
    const opts = makeOpts({
      runStep: async (): Promise<ActionStepResult> => {
        calls++;
        if (calls === 2) return { ok: false, message: 'selector missing' };
        return { ok: true };
      },
    });
    const out = await runReplay(makeSkill(), {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.code).toBe('skill_step_failed');
      expect(out.step_index).toBe(1);
      expect(out.message).toContain('selector missing');
    }
    expect(calls).toBe(2);
  });

  test('rejects unsupported step shapes before invoking the runner', async () => {
    const opts = makeOpts();
    const skill = makeSkill({
      steps: { actions: [{ kind: 'magic-step', payload: 42 }] },
    });
    const out = await runReplay(skill, {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.code).toBe('skill_unsupported_step');
      expect(out.step_index).toBe(0);
    }
  });

  test('rejects skills with no actions array', async () => {
    const opts = makeOpts();
    const skill = makeSkill({ steps: { parameters: [] } });
    const out = await runReplay(skill, {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.code).toBe('skill_invalid_steps');
  });
});

describe('runReplay — wait_for + array steps (#930 review)', () => {
  test('accepts wait_for steps with selector + timeout_ms', async () => {
    const calls: ReplayActionStep[] = [];
    const opts = makeOpts({
      runStep: async (_tab, step) => {
        calls.push(step);
        return { ok: true };
      },
    });
    const skill = makeSkill({
      steps: {
        parameters: [],
        actions: [
          { kind: 'click', selector: 'button[type=submit]' },
          { kind: 'wait_for', selector: '.logged-in', timeout_ms: 5000 },
        ],
      },
    });
    const out = await runReplay(skill, {}, opts);
    expect(out).toEqual({ success: true, contract_id: 'ctr_login_success' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ kind: 'wait_for', selector: '.logged-in', timeout_ms: 5000 });
  });

  test('accepts wait_for without timeout_ms (replay runner picks a default)', async () => {
    const calls: ReplayActionStep[] = [];
    const opts = makeOpts({
      runStep: async (_tab, step) => {
        calls.push(step);
        return { ok: true };
      },
    });
    const skill = makeSkill({
      steps: { parameters: [], actions: [{ kind: 'wait_for', selector: '#ready' }] },
    });
    const out = await runReplay(skill, {}, opts);
    expect(out.success).toBe(true);
    expect(calls[0]).toEqual({ kind: 'wait_for', selector: '#ready', timeout_ms: undefined });
  });

  test('accepts top-level array steps as recorded by oc_skill_record', async () => {
    // oc_skill_record stores steps as an array, not { actions: [...] }.
    // The replay handler now accepts both shapes.
    const calls: ReplayActionStep[] = [];
    const opts = makeOpts({
      runStep: async (_tab, step) => {
        calls.push(step);
        return { ok: true };
      },
    });
    const skill = makeSkill({
      steps: [
        { kind: 'fill', selector: '#user', valueParam: 'username' },
        { kind: 'click', selector: 'button[type=submit]' },
      ] as unknown as SkillRecord['steps'],
    });
    const out = await runReplay(skill, { username: 'demo' }, opts);
    expect(out).toEqual({ success: true, contract_id: 'ctr_login_success' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ kind: 'fill', selector: '#user', valueParam: 'username' });
  });

  test('rejects wait_for missing a selector', async () => {
    const opts = makeOpts();
    const skill = makeSkill({
      steps: { actions: [{ kind: 'wait_for', timeout_ms: 1000 }] },
    });
    const out = await runReplay(skill, {}, opts);
    expect(out.success).toBe(false);
    if (!out.success) expect(out.code).toBe('skill_unsupported_step');
  });
});
