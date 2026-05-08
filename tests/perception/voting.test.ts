import {
  VotingOrchestrator,
  VotingSessionBudget,
  actionsEquivalent,
  extractFirstJsonObject,
  type ActionInvocation,
  type ProviderReply,
  type VoteRequest,
  type VotingProvider,
} from '../../src/perception/voting';

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
    // Per-axis check would have accepted this; radial distance is
    // sqrt(50) ≈ 7.07px, exceeding the 5px tolerance — so it must
    // escalate rather than merge two genuinely different click targets.
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

  test('continues past a non-JSON brace segment to find a later JSON object', () => {
    // Provider replies sometimes contain brace-wrapped prose ahead
    // of the structured payload. The scanner must not stop at the
    // first balanced `{...}` if it does not parse — keep scanning.
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
    // further charges no-op
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

function fakeProvider(name: string, behavior: () => Promise<ProviderReply>): VotingProvider {
  return {
    name,
    ask: async (_req: VoteRequest) => behavior(),
  };
}

const REQ: VoteRequest = {
  compressedDom: '<dom/>',
  skillName: 'test.skill',
  intent: 'click the buy button',
  allowedActionKinds: ['click', 'type', 'navigate', 'scroll'],
};

describe('VotingOrchestrator — happy path', () => {
  test('two providers agree → proceed=true with agreed action', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 50 })),
        fakeProvider('b', async () => ({
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
      providers: [
        fakeProvider('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 100, y: 100 } },
          tokens: 50,
        })),
        fakeProvider('b', async () => ({
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
      expect(v.disagreement?.providers.map((p) => p.name)).toEqual(['a', 'b']);
    }
  });
});

describe('VotingOrchestrator — single-provider fallback', () => {
  test('graceful: one success + one fail → proceed (advisory)', async () => {
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      providers: [
        fakeProvider('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 100, y: 100 } },
          tokens: 50,
        })),
        fakeProvider('b', async () => ({
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
      providers: [
        fakeProvider('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 100, y: 100 } },
          tokens: 50,
        })),
        fakeProvider('b', async () => ({
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

  test('strict: 3 providers, 2 success + 1 fail → disagreement (not proceed)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 10 })),
        fakeProvider('b', async () => ({ ok: true, action, tokens: 10 })),
        fakeProvider('c', async () => ({
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
      expect(v.disagreement?.providers.map((p) => p.name).sort()).toEqual(['a', 'b', 'c']);
    }
  });

  test('ok:true reply without an action is classified as failure (graceful)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 50, y: 50 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 10 })),
        // Provider B reports success but without a parsed action.
        fakeProvider('b', async () => ({ ok: true, tokens: 10 })),
      ],
    });
    const v = await orch.runVote(REQ);
    // Graceful single-success path: A's action stands; only A is the voter.
    expect(v.proceed).toBe(true);
    if (v.proceed) {
      expect(v.voters).toEqual(['a']);
    }
  });

  test('ok:true reply without an action is classified as failure (strict → disagreement)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 50, y: 50 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 10 })),
        fakeProvider('b', async () => ({ ok: true, tokens: 10 })),
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('synchronous throw from a provider is treated as failure (no crash)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 10, y: 10 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'graceful',
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 5 })),
        // Provider B throws synchronously during the request build.
        {
          name: 'b',
          ask: () => {
            throw new Error('synchronous boom');
          },
        },
      ],
    });
    const v = await orch.runVote(REQ);
    expect(v.proceed).toBe(true); // graceful single-survivor
  });

  test('hung provider is bounded by orchestrator wall-clock timeout', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 1, y: 1 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      timeoutMs: 50,
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 5 })),
        // Provider B never resolves — orchestrator must time it out.
        {
          name: 'b',
          ask: () => new Promise<ProviderReply>(() => undefined),
        },
      ],
    });
    const start = Date.now();
    const v = await orch.runVote(REQ);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // does not hang forever
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('throwing equivalence resolver is treated as disagreement (no crash)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { selector: '#a' } };
    const orch = new VotingOrchestrator({
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 5 })),
        fakeProvider('b', async () => ({
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
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 5 })),
        // Provider B reports ok with an empty action object.
        fakeProvider('b', async () => ({
          ok: true,
          action: {} as ActionInvocation,
          tokens: 5,
        })),
      ],
    });
    const v = await orch.runVote(REQ);
    // Graceful: A's action stands as the surviving voter.
    expect(v.proceed).toBe(true);
    if (v.proceed) expect(v.voters).toEqual(['a']);
  });

  test('rejected provider promise is treated as failure (no throw)', async () => {
    const action: ActionInvocation = { kind: 'click', args: { x: 100, y: 100 } };
    const orch = new VotingOrchestrator({
      fallbackMode: 'strict',
      providers: [
        fakeProvider('a', async () => ({ ok: true, action, tokens: 10 })),
        {
          name: 'b',
          ask: async () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const v = await orch.runVote(REQ);
    // strict + one failure → disagreement, never crash
    expect(v.proceed).toBe(false);
    if (!v.proceed) expect(v.reason).toBe('disagreement');
  });

  test('all providers fail → reason=all_failed', async () => {
    const orch = new VotingOrchestrator({
      providers: [
        fakeProvider('a', async () => ({ ok: false, error: { kind: 'timeout', raw: 't' } })),
        fakeProvider('b', async () => ({ ok: false, error: { kind: 'network', raw: 'n' } })),
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
      providers: [
        fakeProvider('a', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 1, y: 1 } },
          tokens: 60,
        })),
        fakeProvider('b', async () => ({
          ok: true,
          action: { kind: 'click', args: { x: 1, y: 1 } },
          tokens: 60,
        })),
      ],
    });
    const v1 = await orch.runVote(REQ); // burns 120 tokens
    expect(v1.proceed).toBe(true);
    expect(budget.isDisabled()).toBe(true);

    const v2 = await orch.runVote(REQ);
    expect(v2.proceed).toBe(false);
    if (!v2.proceed) expect(v2.reason).toBe('kill_switch');
  });
});
