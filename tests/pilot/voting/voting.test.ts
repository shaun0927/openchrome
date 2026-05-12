/**
 * Tests for the pilot multi-model voting framework (Phase 4, replaces #759).
 *
 * The framework is voter-agnostic: a Voter can be deterministic or LLM-backed.
 * All tests here use deterministic voters — no API keys required.
 *
 * LLM-backed voter HTTP wrappers (Anthropic, OpenAI) are out of scope per P3
 * and ship in `openchrome-perception-voters` (#775).
 *
 * Adapted from the closed PR #759 test suite (tests/perception/voting.test.ts).
 * Adaptations:
 *   - Import path: src/pilot/voting (not src/perception/voting)
 *   - VotingProvider → Voter (voter-agnostic rename)
 *   - `providers` field → `voters` field in VotingOrchestratorOptions
 *   - `disagreement.providers` → `disagreement.voters`
 *   - Feature-flag env var set in beforeAll; reset in afterAll
 *   - Added deterministic-voter suite demonstrating no-API-key usage
 */

import {
  VotingOrchestrator,
  VotingSessionBudget,
  actionsEquivalent,
  extractFirstJsonObject,
  vote,
  type ActionInvocation,
  type Voter,
  type VoterReply,
  type VoteRequest,
} from '../../../src/pilot/voting';

/* ------------------------------------------------------------------ */
/* Deterministic voter helpers                                         */
/* ------------------------------------------------------------------ */

/**
 * Factory for deterministic test voters. These demonstrate the framework
 * works end-to-end without any LLM API calls or credentials.
 */
function makeVoter(name: string, behavior: () => Promise<VoterReply>): Voter {
  return {
    name,
    vote: async (_req: VoteRequest) => behavior(),
  };
}

/**
 * "always-proceed" voter: deterministically returns the provided action.
 * Useful for testing agreement paths without LLMs.
 */
function alwaysProceedVoter(name: string, action: ActionInvocation): Voter {
  return makeVoter(name, async () => ({ ok: true, action, tokens: 0 }));
}

/**
 * "always-abstain" voter: deterministically returns a failure reply.
 * Useful for testing fallback / all_failed paths without LLMs.
 */
function alwaysAbstainVoter(name: string): Voter {
  return makeVoter(name, async () => ({
    ok: false,
    tokens: 0,
    error: { kind: 'unknown', raw: 'voter abstained deterministically' },
  }));
}

const REQ: VoteRequest = {
  compressedDom: '<dom/>',
  skillName: 'test.skill',
  intent: 'click the buy button',
  allowedActionKinds: ['click', 'type', 'navigate', 'scroll'],
};

/* ------------------------------------------------------------------ */
/* Deterministic voter suite (no API keys required)                   */
/* ------------------------------------------------------------------ */

describe('deterministic voters — framework works without LLMs', () => {
  test('two always-proceed voters with same action → proceed=true', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      voters: [
        alwaysProceedVoter('always-proceed-a', action),
        alwaysProceedVoter('always-proceed-b', action),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
    if (v.proceed) {
      expect(v.agreedAction).toEqual(action);
      expect(v.voters).toEqual(['always-proceed-a', 'always-proceed-b']);
    }
  });

  test('two always-abstain voters → reason=all_failed', async () => {
    const orch = new VotingOrchestrator({
      voters: [
        alwaysAbstainVoter('abstain-a'),
        alwaysAbstainVoter('abstain-b'),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) {
      expect(v.reason).toBe('all_failed');
    }
  });

  test('always-proceed + always-abstain (graceful) → proceed=true (advisory)', async () => {
    const action: ActionInvocation = { kind: 'navigate', args: { url: 'https://example.com/' } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      voters: [
        alwaysProceedVoter('proceed', action),
        alwaysAbstainVoter('abstain'),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
    if (v.proceed) {
      expect(v.voters).toEqual(['proceed']);
    }
  });

  test('always-proceed + always-abstain (strict) → disagreement', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 1, y: 1 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      voters: [
        alwaysProceedVoter('proceed', action),
        alwaysAbstainVoter('abstain'),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) {
      expect(v.reason).toBe('disagreement');
    }
  });

  test('structural-match voters with equivalent actions (within 5px) → proceed=true', async () => {
    // Demonstrates a "structural-match" pattern: voters emit actions
    // derived from DOM analysis — still deterministic, no LLM.
    const orch = new VotingOrchestrator({
      voters: [
        alwaysProceedVoter('structural-a', { kind: 'click', args: { x: 100, y: 200 } }),
        alwaysProceedVoter('structural-b', { kind: 'click', args: { x: 103, y: 198 } }),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Feature flag disabled                                               */
/* ------------------------------------------------------------------ */

describe('feature flag disabled → proceed=false reason=disabled', () => {
  test('vote() convenience wrapper returns disabled verdict when OPENCHROME_PILOT is unset', async () => {
    // The vote() wrapper checks isPerceptionVotingEnabled() which requires
    // OPENCHROME_PILOT to be set. Without it the wrapper short-circuits.
    const savedPilot = process.env['OPENCHROME_PILOT'];
    delete process.env['OPENCHROME_PILOT'];
    // Reset the cached pilot flag so the change takes effect.
    const { resetFlagsCache } = await import('../../../src/harness/flags');
    resetFlagsCache();

    const action: ActionInvocation = { kind: 'click', args: { x: 1, y: 1 } };
    const orch = new VotingOrchestrator({
      voters: [
        alwaysProceedVoter('a', action),
        alwaysProceedVoter('b', action),
      ],
    });
    const v = await vote(orch, REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) {
      expect(v.reason).toBe('disabled');
    }
    // Restore.
    if (savedPilot !== undefined) {
      process.env['OPENCHROME_PILOT'] = savedPilot;
    }
    resetFlagsCache();
  });
});

/* ------------------------------------------------------------------ */
/* args-equivalence                                                    */
/* ------------------------------------------------------------------ */

describe('actionsEquivalent — click', () => {
  test('different kinds → not equivalent', () => {
    expect(actionsEquivalent({ kind: 'click', args: {} }, { kind: 'navigate', args: {} })).toBe(false);
  });

  test('coordinates within ±5 px → equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'click', args: { x: 100, y: 200 } },
        { kind: 'click', args: { x: 103, y: 198 } },
      ),
    ).toBe(true);
  });

  test('diagonal offset (5,5) is NOT equivalent — radial distance > 5px', () => {
    expect(
      actionsEquivalent(
        { kind: 'click', args: { x: 100, y: 200 } },
        { kind: 'click', args: { x: 105, y: 205 } },
      ),
    ).toBe(false);
  });

  test('coordinates outside ±5 px → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'click', args: { x: 100, y: 200 } },
        { kind: 'click', args: { x: 110, y: 200 } },
      ),
    ).toBe(false);
  });

  test('selector + coords resolved to same backendNodeId → equivalent', () => {
    const ctx = { resolveTarget: () => 7 };
    expect(
      actionsEquivalent(
        { kind: 'click', args: { selector: '#buy' } },
        { kind: 'click', args: { x: 200, y: 300 } },
        ctx,
      ),
    ).toBe(true);
  });

  test('resolver returns null on either side → not equivalent', () => {
    const ctx = {
      resolveTarget: (a: ActionInvocation) =>
        (a.args as { tag?: string }).tag === 'a' ? 7 : null,
    };
    expect(
      actionsEquivalent(
        { kind: 'click', args: { tag: 'a' } },
        { kind: 'click', args: { tag: 'b' } },
        ctx,
      ),
    ).toBe(false);
  });
});

describe('actionsEquivalent — type / fill_input', () => {
  test('same selector + text-after-trim → equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'type', args: { selector: '#email', text: 'a@b.c ' } },
        { kind: 'type', args: { selector: '#email', text: 'a@b.c' } },
      ),
    ).toBe(true);
  });

  test('different text → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'type', args: { selector: '#x', text: 'A' } },
        { kind: 'type', args: { selector: '#x', text: 'B' } },
      ),
    ).toBe(false);
  });

  test('different selector → not equivalent (no resolver)', () => {
    expect(
      actionsEquivalent(
        { kind: 'type', args: { selector: '#a', text: 't' } },
        { kind: 'type', args: { selector: '#b', text: 't' } },
      ),
    ).toBe(false);
  });

  test('missing selector/ref targets are not equivalent (no resolver)', () => {
    expect(
      actionsEquivalent(
        { kind: 'type', args: { text: 't' } },
        { kind: 'type', args: { text: 't' } },
      ),
    ).toBe(false);
  });

  test('missing text is not equivalent even with matching target', () => {
    expect(
      actionsEquivalent(
        { kind: 'type', args: { selector: '#email' } },
        { kind: 'type', args: { selector: '#email' } },
      ),
    ).toBe(false);
  });

  test('fill_input behaves identically to type', () => {
    expect(
      actionsEquivalent(
        { kind: 'fill_input', args: { selector: '#x', text: 'hi' } },
        { kind: 'fill_input', args: { selector: '#x', text: 'hi' } },
      ),
    ).toBe(true);
  });
});

describe('actionsEquivalent — navigate', () => {
  test('URLs match after dropping trailing slash + tracking params', () => {
    expect(
      actionsEquivalent(
        { kind: 'navigate', args: { url: 'https://x.com/page?utm_source=email' } },
        { kind: 'navigate', args: { url: 'https://x.com/page/' } },
      ),
    ).toBe(true);
  });

  test('different paths → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'navigate', args: { url: 'https://x.com/a' } },
        { kind: 'navigate', args: { url: 'https://x.com/b' } },
      ),
    ).toBe(false);
  });

  test('path trailing slash with query string is normalized', () => {
    expect(
      actionsEquivalent(
        { kind: 'navigate', args: { url: 'https://x.com/page/?id=1' } },
        { kind: 'navigate', args: { url: 'https://x.com/page?id=1' } },
      ),
    ).toBe(true);
  });

  test('path trailing slash with fragment is normalized', () => {
    expect(
      actionsEquivalent(
        { kind: 'navigate', args: { url: 'https://x.com/page/#section' } },
        { kind: 'navigate', args: { url: 'https://x.com/page#section' } },
      ),
    ).toBe(true);
  });

  test('invalid URL → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'navigate', args: { url: 'not a url' } },
        { kind: 'navigate', args: { url: 'https://x.com' } },
      ),
    ).toBe(false);
  });
});

describe('actionsEquivalent — scroll', () => {
  test('within ±50 px AND same frame → equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'scroll', args: { dx: 0, dy: 100, frame_id: 'f1' } },
        { kind: 'scroll', args: { dx: 10, dy: 130, frame_id: 'f1' } },
      ),
    ).toBe(true);
  });

  test('outside ±50 px → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'scroll', args: { dy: 100 } },
        { kind: 'scroll', args: { dy: 200 } },
      ),
    ).toBe(false);
  });

  test('different frames → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'scroll', args: { dy: 100, frame_id: 'main' } },
        { kind: 'scroll', args: { dy: 100, frame_id: 'iframe1' } },
      ),
    ).toBe(false);
  });
});

describe('actionsEquivalent — unknown kinds fall through to deep-equal', () => {
  test('matching unknown action → equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'press_key', args: { key: 'Enter', modifiers: ['Meta'] } },
        { kind: 'press_key', args: { key: 'Enter', modifiers: ['Meta'] } },
      ),
    ).toBe(true);
  });

  test('non-matching unknown action → not equivalent', () => {
    expect(
      actionsEquivalent(
        { kind: 'press_key', args: { key: 'Enter' } },
        { kind: 'press_key', args: { key: 'Escape' } },
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* extractFirstJsonObject                                              */
/* ------------------------------------------------------------------ */

describe('extractFirstJsonObject', () => {
  test('parses bare JSON', () => {
    expect(extractFirstJsonObject('{"action":"click","args":{}}')).toEqual({
      action: 'click',
      args: {},
    });
  });

  test('strips ```json fences', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('strips ``` fences without language tag', () => {
    expect(extractFirstJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('skips leading prose', () => {
    expect(extractFirstJsonObject('Sure! Here is the action: {"a":1} hope this helps')).toEqual({
      a: 1,
    });
  });

  test('handles nested braces', () => {
    expect(extractFirstJsonObject('{"a":{"b":2},"c":[1,2]}')).toEqual({
      a: { b: 2 },
      c: [1, 2],
    });
  });

  test('balanced-brace scan ignores braces inside strings', () => {
    expect(extractFirstJsonObject('{"a":"{not json}","b":1}')).toEqual({
      a: '{not json}',
      b: 1,
    });
  });

  test('ignores stray closing braces preceding the JSON object', () => {
    expect(extractFirstJsonObject('closing } stray. {"action":"click"}')).toEqual({ action: 'click' });
  });

  test('continues past a non-JSON brace segment to find a later JSON object', () => {
    expect(
      extractFirstJsonObject('Reasoning: {note: this is prose} Result: {"action":"click","args":{}}'),
    ).toEqual({ action: 'click', args: {} });
  });

  test('returns null when every brace segment fails to parse', () => {
    expect(extractFirstJsonObject('{not json} {also bad}')).toBeNull();
  });

  test('returns null on unterminated input', () => {
    expect(extractFirstJsonObject('{"a":1')).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(extractFirstJsonObject('')).toBeNull();
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* VotingSessionBudget                                                 */
/* ------------------------------------------------------------------ */

describe('VotingSessionBudget', () => {
  test('charge accumulates total and tracks remaining', () => {
    const b = new VotingSessionBudget(100);
    expect(b.charge(40)).toBe(true);
    expect(b.charge(40)).toBe(true);
    expect(b.totalUsed()).toBe(80);
    expect(b.remaining()).toBe(20);
    expect(b.isDisabled()).toBe(false);
  });

  test('crossing the cap disables the budget irreversibly', () => {
    const b = new VotingSessionBudget(100);
    b.charge(60);
    expect(b.charge(50)).toBe(false);
    expect(b.isDisabled()).toBe(true);
    expect(b.charge(10)).toBe(false);
  });

  test('floors negative / non-integer charges to safe values', () => {
    const b = new VotingSessionBudget(100);
    b.charge(-50);
    b.charge(7.9);
    expect(b.totalUsed()).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* VotingOrchestrator                                                  */
/* ------------------------------------------------------------------ */

describe('VotingOrchestrator — happy path', () => {
  test('two voters agree → proceed=true with agreed action', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 50 })),
        makeVoter('b', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 102, y: 99 } },
          tokens: 50,
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
    if (v.proceed) {
      expect(v.agreedAction.kind).toBe('click');
      expect(v.voters).toEqual(['a', 'b']);
    }
  });
});

describe('VotingOrchestrator — disagreement', () => {
  test('two successful but conflicting actions → disagreement', async () => {
    const orch = new VotingOrchestrator({
      voters: [
        makeVoter('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 100, y: 100 } },
          tokens: 50,
        })),
        makeVoter('b', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 500, y: 500 } },
          tokens: 50,
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) {
      expect(v.reason).toBe('disagreement');
      expect(v.disagreement?.voters.map((p) => p.name)).toEqual(['a', 'b']);
    }
  });
});

describe('VotingOrchestrator — single-voter fallback', () => {
  test('graceful: one success + one fail → proceed (advisory)', async () => {
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      voters: [
        makeVoter('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 100, y: 100 } },
          tokens: 50,
        })),
        makeVoter('b', async () => ({
          ok: false,
          tokens: 0,
          error: { kind: 'timeout', raw: 'request timed out' },
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
  });

  test('strict: one success + one fail → disagreement', async () => {
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      voters: [
        makeVoter('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 100, y: 100 } },
          tokens: 50,
        })),
        makeVoter('b', async () => ({
          ok: false,
          tokens: 0,
          error: { kind: 'auth', raw: '401' },
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('strict: 3 voters, 2 success + 1 fail → disagreement (not proceed)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 10 })),
        makeVoter('b', async () => ({ ok: true, action, tokens: 10 })),
        makeVoter('c', async () => ({
          ok: false,
          tokens: 0,
          error: { kind: 'network', raw: 'EHOSTUNREACH' },
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) {
      expect(v.reason).toBe('disagreement');
      expect(v.disagreement?.voters.map((p) => p.name).sort()).toEqual(['a', 'b', 'c']);
    }
  });

  test('ok:true reply without an action is classified as failure (graceful)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 50, y: 50 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 10 })),
        makeVoter('b', async () => ({ ok: true, tokens: 10 })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
    if (v.proceed) {
      expect(v.voters).toEqual(['a']);
    }
  });

  test('ok:true reply without an action is classified as failure (strict → disagreement)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 50, y: 50 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 10 })),
        makeVoter('b', async () => ({ ok: true, tokens: 10 })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('non-object voter reply is classified as failure (no crash)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 50, y: 50 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 10 })),
        makeVoter('b', async () => null as unknown as VoterReply),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('synchronous throw from a voter is treated as failure (no crash)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 10, y: 10 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 5 })),
        {
          name: 'b',
          vote: () => {
            throw new Error('synchronous boom');
          },
        },
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
  });

  test('hung voter is bounded by orchestrator wall-clock timeout', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 1, y: 1 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      timeoutMs: 50,
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 5 })),
        {
          name: 'b',
          vote: () => new Promise<VoterReply>(() => undefined),
        },
      ],
    });
    const start = Date.now();
    const v = await orch.runVote(REQ);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  }, 5000);

  test('throwing equivalence resolver is treated as disagreement (no crash)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { selector: '#a' } };
    const orch = new VotingOrchestrator({
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 5 })),
        makeVoter('b', async () => ({
          ok: true,
          action: { kind: 'click', args: { selector: '#b' } },
          tokens: 5,
        })),
      ],
      equivalence: {
        resolveTarget: () => {
          throw new Error('resolver crashed');
        },
      },
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('action without a non-empty kind is rejected as failure', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 1, y: 1 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 5 })),
        makeVoter('b', async () => ({
          ok: true,
          action: {} as ActionInvocation,
          tokens: 5,
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true);
    if (v.proceed) expect(v.voters).toEqual(['a']);
  });

  test('rejected voter promise is treated as failure (no throw)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      voters: [
        makeVoter('a', async () => ({ ok: true, action, tokens: 10 })),
        {
          name: 'b',
          vote: async () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('all voters fail → reason=all_failed', async () => {
    const orch = new VotingOrchestrator({
      voters: [
        makeVoter('a', async () => ({ ok: false, error: { kind: 'timeout', raw: 't' } })),
        makeVoter('b', async () => ({ ok: false, error: { kind: 'network', raw: 'n' } })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('all_failed');
  });
});

describe('VotingOrchestrator — kill switch', () => {
  test('cumulative tokens past cap disables further voting', async () => {
    const budget = new VotingSessionBudget(100);
    const orch = new VotingOrchestrator({
      budget,
      voters: [
        makeVoter('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 1, y: 1 } },
          tokens: 60,
        })),
        makeVoter('b', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 1, y: 1 } },
          tokens: 60,
        })),
      ],
    });
    const v1 = await orch.runVote(REQ);
    expect(v1.proceed).toBe(true);
    expect(budget.isDisabled()).toBe(true);

    const v2 = await orch.runVote(REQ);
    expect(v2.proceed).toBe(false);
    if (!v2.proceed) expect(v2.reason).toBe('kill_switch');
  });
});
