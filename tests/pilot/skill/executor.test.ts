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

// Capture and restore process.argv so the pilot flag we set in this suite
// does not bleed into other Jest workers running in the same process.
const ORIGINAL_ARGV = process.argv;

beforeAll(() => {
  process.argv = ['node', 'cli/index.js', '--pilot'];
  resetFlagsCache();
});

afterAll(() => {
  process.argv = ORIGINAL_ARGV;
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
  test('a snapshot reader that throws falls through to host_decides', () => {
    const storage = openStorage();
    const wrapped = Object.create(storage);
    wrapped.getEdgesFromStateSync = () => {
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

describe('decide() — single snapshot coherence', () => {
  // Regression guard for PR #823 review (Codex): "Read edge data from a
  // single graph snapshot". The previous implementation invoked
  // `storage.getEdge()` once per candidate, which re-read the JSON file
  // each call and risked comparing edges from different graph versions
  // when a concurrent writer mutated the file mid-decision. The current
  // implementation must consult exactly one `getEdgesFromStateSync` read
  // per call and must never reach for `getEdge` from within `decide()`.
  test('decide() reads the graph exactly once regardless of candidate count', () => {
    const storage = openStorage();
    const counts = { snapshot: 0, edge: 0 };
    const wrapped = Object.create(storage);
    wrapped.getEdgesFromStateSync = (_fromState: string) => {
      counts.snapshot += 1;
      return [];
    };
    wrapped.getEdge = () => {
      counts.edge += 1;
      return null;
    };
    decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD, CLICK_CHECKOUT, NAV],
      },
      wrapped,
    );
    expect(counts.snapshot).toBe(1);
    expect(counts.edge).toBe(0);
  });

  test('all candidates are ranked against the same snapshot even if storage mutates between iterations', () => {
    const storage = openStorage();
    // Two snapshot reads with different content. The first response wins
    // — `decide` must consult the snapshot once, then iterate candidates
    // in memory.
    const snapshots = [
      [
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'add-to-cart',
          toStateDistribution: [{ to_state: POST_ADD_STATE, count: 10 }],
          successCount: 10,
          failCount: 0,
        },
      ],
      // If decide() leaked a second read through, it would see this list
      // and pick CLICK_CHECKOUT instead, which is the failure mode we
      // are guarding against.
      [
        {
          fromState: COLD_STATE,
          actionKind: 'click',
          actionArgsNorm: 'checkout',
          toStateDistribution: [{ to_state: 'state_other', count: 50 }],
          successCount: 50,
          failCount: 0,
        },
      ],
    ];
    let call = 0;
    const wrapped = Object.create(storage);
    wrapped.getEdgesFromStateSync = (_fromState: string) =>
      snapshots[Math.min(call++, snapshots.length - 1)];
    const decision = decide(
      {
        domain: 'example.com',
        currentStateHash: COLD_STATE,
        candidateActions: [CLICK_ADD, CLICK_CHECKOUT],
      },
      wrapped,
    );
    expect(decision.kind).toBe('recommended');
    expect(decision.recommended).toEqual(CLICK_ADD);
  });
});

describe('executor source — text-tooling friendliness', () => {
  // Regression guard for PR #823 review (Codex): "Remove embedded NUL
  // byte from TypeScript source". Any control byte below U+0020 except
  // TAB (0x09), LF (0x0A), and CR (0x0D) makes Git treat the file as
  // binary, breaking diff/grep/code review. This assertion catches a
  // future re-introduction.
  test('src/pilot/skill/executor.ts contains no raw control bytes outside TAB/LF/CR', () => {
    const buf = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'pilot', 'skill', 'executor.ts'),
    );
    const offenders: Array<{ offset: number; byte: number }> = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
        offenders.push({ offset: i, byte: b });
        if (offenders.length >= 5) break;
      }
    }
    expect(offenders).toEqual([]);
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
