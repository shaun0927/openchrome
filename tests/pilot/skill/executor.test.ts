/**
 * Tests for the pilot-tier skill graph executor (issue #820, blocks #717).
 *
 * The executor is a pure decision function backed by the per-domain JSON
 * skill graph storage in src/core/skill/. Each test prepares an isolated
 * `rootDir` under `os.tmpdir()`, seeds the graph through the public
 * SkillGraphStorage API, then invokes `decide()` and asserts the shape of
 * the returned ExecutorDecision.
 *
 * All tests run with the pilot flag forced on so that any future call-site
 * gating on `isPilotEnabled()` is exercised the same way real consumers
 * will see the module.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SkillGraphStorage } from '../../../src/core/skill/index.js';
import {
  decide,
  DISTRIBUTION_MATCH_THRESHOLD,
  RECOMMEND_RATE_FLOOR,
  SMALL_SAMPLE_TOTAL,
} from '../../../src/pilot/skill/index.js';
import type { ExecutorAction } from '../../../src/pilot/skill/index.js';
import { resetFlagsCache } from '../../../src/harness/flags.js';

let tmpRoot: string;

beforeAll(() => {
  process.argv = ['node', 'cli/index.js', '--pilot'];
  resetFlagsCache();
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'oc-executor-test-'),
  );
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function openStorage(domain = 'example.com'): SkillGraphStorage {
  return new SkillGraphStorage({ domain, rootDir: tmpRoot });
}

const CLICK_ADD: ExecutorAction = { kind: 'click', argsNorm: 'add-to-cart' };
const CLICK_CHECKOUT: ExecutorAction = {
  kind: 'click',
  argsNorm: 'checkout',
};
const NAV: ExecutorAction = { kind: 'navigate', argsNorm: 'home' };

const COLD_STATE = 'state_cold';
const POST_ADD_STATE = 'state_cart_populated';

describe('decide() — cold graph', () => {
  test('returns host_decides when no edges exist for the given state', () => {
    const storage = openStorage();
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD, CLICK_CHECKOUT],
      },
      storage,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe('no_matching_edges');
    expect(decision.recommended).toBeUndefined();
    expect(decision.skipUntil).toBeUndefined();
  });
});

describe('decide() — already_at_target', () => {
  test('returns already_at_target when the matched edge top to_state equals currentStateHash', async () => {
    const storage = openStorage();
    // Seed: from current state, click add-to-cart historically ends at
    // current state itself (a self-loop signal that the cart is already
    // populated).
    for (let i = 0; i < 3; i++) {
      await storage.recordEdge({
        from_state: POST_ADD_STATE,
        action_kind: 'click',
        action_args_norm: 'add-to-cart',
        to_state: POST_ADD_STATE,
      });
      await storage.recordSuccess(
        {
          fromState: POST_ADD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'add-to-cart',
        },
        POST_ADD_STATE,
      );
    }
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: POST_ADD_STATE,
        candidateActions: [CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('already_at_target');
    expect(decision.skipUntil).toBe(POST_ADD_STATE);
    expect(decision.reason).toMatch(/click\/add-to-cart/);
  });

  test('skips the already_at_target signal when the distribution top to_state differs', async () => {
    const storage = openStorage();
    // Action led to a different state, not the current one.
    await storage.recordEdge({
      from_state: COLD_STATE,
      action_kind: 'click',
      action_args_norm: 'add-to-cart',
      to_state: 'state_other',
    });
    await storage.recordSuccess(
      {
        fromState: COLD_STATE,
        actionKind: 'click',
        actionArgsNorm: 'add-to-cart',
      },
      'state_other',
    );
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).not.toBe('already_at_target');
  });
});

describe('decide() — recommended', () => {
  test('picks the candidate with the highest success rate from currentStateHash', async () => {
    const storage = openStorage();
    // Seed a confident edge for CLICK_ADD: 6 successes, 1 fail (rate ≈ 0.86).
    for (let i = 0; i < 6; i++) {
      await storage.recordSuccess(
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'add-to-cart',
        },
        POST_ADD_STATE,
      );
    }
    await storage.recordFailure(
      {
        fromState: COLD_STATE,
        actionKind: 'click',
        actionArgsNorm: 'add-to-cart',
      },
      'transient',
    );
    // Seed CLICK_CHECKOUT as below the floor: 1 success, 4 fails (rate 0.2).
    await storage.recordSuccess(
      {
        fromState: COLD_STATE,
        actionKind: 'click',
        actionArgsNorm: 'checkout',
      },
      'state_other',
    );
    for (let i = 0; i < 4; i++) {
      await storage.recordFailure(
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'checkout',
        },
        'transient',
      );
    }

    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_CHECKOUT, CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('recommended');
    expect(decision.recommended).toEqual(CLICK_ADD);
    expect(decision.reason).toMatch(/successRate=0\.86/);
  });

  test('breaks ties on raw success_count, preserving topEdges ordering parity', async () => {
    const storage = openStorage();
    // Two candidates with identical 100% rate, but A has more invocations.
    for (let i = 0; i < 5; i++) {
      await storage.recordSuccess(
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'add-to-cart',
        },
        POST_ADD_STATE,
      );
    }
    for (let i = 0; i < 2; i++) {
      await storage.recordSuccess(
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'checkout',
        },
        'state_other',
      );
    }
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_CHECKOUT, CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('recommended');
    expect(decision.recommended).toEqual(CLICK_ADD);
  });

  test('returns host_decides when no candidate clears RECOMMEND_RATE_FLOOR', async () => {
    const storage = openStorage();
    // Rate 0.4 — below the 0.5 floor.
    for (let i = 0; i < 2; i++) {
      await storage.recordSuccess(
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'add-to-cart',
        },
        POST_ADD_STATE,
      );
    }
    for (let i = 0; i < 3; i++) {
      await storage.recordFailure(
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'add-to-cart',
        },
        'transient',
      );
    }
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe('no_confident_candidate');
  });
});

describe('decide() — input validation', () => {
  test.each([
    ['invalid_input', null],
    ['invalid_input', 42],
  ])('returns host_decides reason=%s for non-object input', (reason, bad) => {
    const storage = openStorage();
    const decision = decide(bad as unknown as never, storage);
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe(reason);
  });

  test('returns host_decides for empty domain', () => {
    const storage = openStorage();
    const decision = decide(
      {
        domain: '',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe('invalid_domain');
  });

  test('returns host_decides for empty currentStateHash', () => {
    const storage = openStorage();
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: '',
        candidateActions: [CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe('invalid_state_hash');
  });

  test('returns host_decides for empty candidateActions', () => {
    const storage = openStorage();
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [],
      },
      storage,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe('empty_candidate_actions');
  });

  test('returns host_decides when storage.domain disagrees with input.domain', () => {
    const storage = openStorage('first.example');
    const decision = decide(
      {
        domain: 'second.example',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD],
      },
      storage,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toBe('storage_domain_mismatch');
  });

  test('skips malformed candidates inside an otherwise valid list', async () => {
    const storage = openStorage();
    for (let i = 0; i < 5; i++) {
      await storage.recordSuccess(
        {
          fromState: COLD_STATE,
          actionKind: 'navigate',
          actionArgsNorm: 'home',
        },
        'state_home',
      );
    }
    const malformed = { kind: '', argsNorm: '' } as ExecutorAction;
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [malformed, NAV],
      },
      storage,
    );
    expect(decision.kind).toBe('recommended');
    expect(decision.recommended).toEqual(NAV);
  });
});

describe('decide() — total / never throws', () => {
  test('a getEdge() implementation that throws falls through to host_decides', () => {
    const storage = openStorage();
    const wrapped = Object.create(storage);
    wrapped.getEdge = () => {
      throw new Error('synthetic storage failure');
    };
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD],
      },
      wrapped,
    );
    expect(decision.kind).toBe('host_decides');
    expect(decision.reason).toMatch(/storage_error: synthetic storage failure/);
  });
});

describe('threshold constants — defensive sanity', () => {
  test('the exported constants match the closed PR #739 baseline', () => {
    // Locking these in so future tuning is an intentional change with a
    // visible diff rather than a silent drift.
    expect(DISTRIBUTION_MATCH_THRESHOLD).toBeCloseTo(0.1);
    expect(SMALL_SAMPLE_TOTAL).toBe(10);
    expect(RECOMMEND_RATE_FLOOR).toBeCloseTo(0.5);
  });
});
