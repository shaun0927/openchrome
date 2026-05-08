import {
  buildMergePrompt,
  createLlmMergeRequester,
  createLlmMergeRequesterFromRawText,
  type RawTextProvider,
} from '../../src/skill-memory/llm-merge';
import type { MergeRequest } from '../../src/skill-memory/curator-pass2';
import type { SkillRecord } from '../../src/skill-memory/types';
import type { VotingProvider, ProviderReply } from '../../src/perception/voting/orchestrator';

function rec(name: string, intent: string, runs: number): SkillRecord {
  return {
    skill_id: name,
    filePath: `/tmp/${name}.md`,
    sidecarPath: `/tmp/${name}.json`,
    frontmatter: {
      schema_version: 1,
      name,
      domain: 'amazon.com',
      intent,
      status: 'promoted',
      verified_runs: runs,
      last_verified_at: '2026-05-08T12:00:00Z',
      contract_ref: 'txn',
      graph_node_anchor: 'a1b2',
      author: 'agent',
    },
    sidecar: {
      schema_version: 1,
      skill_id: name,
      graph_node_anchor: 'a1b2',
      contract_id: 'cid',
      runs: { count: runs, window_start: '2026-04-01T00:00:00Z', recent: [] },
    },
  };
}

const REQ: MergeRequest = {
  domain: 'amazon.com',
  cluster: [
    rec('amazon.cart-add', 'Add specific item to cart and checkout', 5),
    rec('amazon.cart-buy', 'Add item, then complete purchase', 4),
  ],
};

function fakeText(textsOrErrors: Array<string | { error: { kind: string; raw: string } }>): RawTextProvider {
  let i = 0;
  return {
    name: 'fake',
    async ask(_prompt: string) {
      const next = textsOrErrors[Math.min(i, textsOrErrors.length - 1)];
      i++;
      if (typeof next === 'string') {
        return { ok: true, text: next, tokens: 100 };
      }
      return { ok: false, error: next.error };
    },
  };
}

/* ------------------------------------------------------------------ */
/* buildMergePrompt                                                    */
/* ------------------------------------------------------------------ */

describe('buildMergePrompt', () => {
  test('non-strict prompt lists every sibling with name + intent + verified_runs', () => {
    const out = buildMergePrompt(REQ, false);
    expect(out).toContain('amazon.cart-add');
    expect(out).toContain('Add specific item to cart and checkout');
    expect(out).toContain('verified_runs=5');
    expect(out).toContain('amazon.cart-buy');
    expect(out).toContain('verified_runs=4');
    expect(out).toContain('"amazon.com"');
    expect(out).toContain('Reply STRICTLY as JSON');
  });

  test('strict prompt appends the no-prose retry instruction', () => {
    const out = buildMergePrompt(REQ, true);
    expect(out).toContain('You replied with non-JSON');
  });

  test('expected JSON shape is documented for the LLM', () => {
    const out = buildMergePrompt(REQ, false);
    expect(out).toContain('"name"');
    expect(out).toContain('"intent"');
    expect(out).toContain('"body"');
  });
});

/* ------------------------------------------------------------------ */
/* createLlmMergeRequesterFromRawText                                  */
/* ------------------------------------------------------------------ */

describe('createLlmMergeRequesterFromRawText — happy path', () => {
  test('parses {name, intent, body} envelope into MergeResult', async () => {
    const provider = fakeText([
      '{"name":"amazon.cart-flow","intent":"Add and buy","body":"## Steps\\n1. Click add\\n2. Click buy\\n"}',
    ]);
    const requester = createLlmMergeRequesterFromRawText(provider);
    const r = await requester(REQ);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('amazon.cart-flow');
      expect(r.intent).toBe('Add and buy');
      expect(r.body).toContain('Steps');
    }
  });

  test('strips ```json fences', async () => {
    const provider = fakeText([
      '```json\n{"name":"u","intent":"i","body":"## b"}\n```',
    ]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('u');
  });

  test('truncates oversize intent (>512) and body (>4000)', async () => {
    const provider = fakeText([
      JSON.stringify({
        name: 'u',
        intent: 'i'.repeat(1000),
        body: 'b'.repeat(10_000),
      }),
    ]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.length).toBe(512);
      expect(r.body.length).toBe(4000);
    }
  });
});

describe('createLlmMergeRequesterFromRawText — strict retry', () => {
  test('non-JSON first → strict retry → success', async () => {
    const provider = fakeText([
      'I cannot do that.',
      '{"name":"u","intent":"i","body":"b"}',
    ]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(true);
  });

  test('two non-JSON replies → merge_parse_failure skip', async () => {
    const provider = fakeText(['nope', 'still nope']);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('merge_parse_failure');
  });
});

describe('createLlmMergeRequesterFromRawText — provider failures', () => {
  test('provider error first → ok:false skip with kind+raw in reason', async () => {
    const provider = fakeText([{ error: { kind: 'rate_limit', raw: '429' } }]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('rate_limit');
      expect(r.reason).toContain('429');
    }
  });

  test('parse fail then provider error → strict-retry error in reason', async () => {
    const provider = fakeText(['nope', { error: { kind: 'auth', raw: '401' } }]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('strict retry');
      expect(r.reason).toContain('auth');
    }
  });
});

describe('createLlmMergeRequesterFromRawText — shape validation', () => {
  test('missing fields → parse failure → skip', async () => {
    const provider = fakeText(['{"name":"u"}', 'still incomplete']);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(false);
  });

  test('non-string name → parse failure → skip', async () => {
    const provider = fakeText([
      '{"name":42,"intent":"i","body":"b"}',
      '{"name":42,"intent":"i","body":"b"}',
    ]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(false);
  });

  test('empty name → parse failure → skip', async () => {
    const provider = fakeText([
      '{"name":"","intent":"i","body":"b"}',
      '{"name":"","intent":"i","body":"b"}',
    ]);
    const r = await createLlmMergeRequesterFromRawText(provider)(REQ);
    expect(r.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* createLlmMergeRequester (VotingProvider adapter)                    */
/* ------------------------------------------------------------------ */

/** Build a stubbed VotingProvider that returns replies in sequence. */
function fakeVotingProvider(replies: ProviderReply[]): VotingProvider {
  let i = 0;
  return {
    name: 'fake-voting',
    async ask(_req, _opts): Promise<ProviderReply> {
      const next = replies[Math.min(i, replies.length - 1)];
      i++;
      return next;
    },
  };
}

/** Merge-shaped JSON that satisfies asMergeOk. */
const VALID_MERGE_JSON = JSON.stringify({
  name: 'amazon.cart-flow',
  intent: 'Add and buy',
  body: '## Steps\n1. Add\n2. Buy\n',
});

describe('createLlmMergeRequester — VotingProvider adapter', () => {
  test('ok=true reply with action.args containing valid merge envelope → returns ok MergeDecision', async () => {
    const actionArgs = { name: 'amazon.cart-flow', intent: 'Add and buy', body: '## Steps\n1. Add\n2. Buy\n' };
    const provider = fakeVotingProvider([
      { ok: true, action: { kind: 'merge', args: actionArgs }, tokens: 50 },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('amazon.cart-flow');
      expect(r.intent).toBe('Add and buy');
    }
  });

  test('reply with kind=malformed whose raw is valid merge JSON → recovered as ok after first attempt', async () => {
    const provider = fakeVotingProvider([
      { ok: false, error: { kind: 'malformed', raw: VALID_MERGE_JSON } },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('amazon.cart-flow');
    }
  });

  test('reply with kind=malformed whose raw is unparseable → abstains immediately (no second call)', async () => {
    // VotingProvider already retried once internally via runWithReplyParse before
    // returning kind='malformed'. Our adapter must NOT make a second callOnce.
    const provider = fakeVotingProvider([
      { ok: false, error: { kind: 'malformed', raw: 'not json at all' } },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('merge_parse_failure');
    }
  });

  test('provider.ask is called exactly ONCE on parse_failure (no double-call)', async () => {
    let callCount = 0;
    const provider: VotingProvider = {
      name: 'counting-provider',
      async ask(_req, _opts): Promise<ProviderReply> {
        callCount++;
        return { ok: false, error: { kind: 'malformed', raw: 'garbage' } };
      },
    };
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(false);
    expect(callCount).toBe(1);
  });

  test('non-malformed provider_error → abstains without retry', async () => {
    // rate_limit should be terminal — no retry into a second call
    const provider = fakeVotingProvider([
      { ok: false, error: { kind: 'rate_limit', raw: '429 Too Many Requests' } },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('provider error');
      expect(r.reason).toContain('rate_limit');
    }
  });

  test('name violating the regex (uppercase letter) → rejected by asMergeOk → abstains', async () => {
    // The provider returns ok=false malformed with an uppercase name — asMergeOk should reject it.
    // No second call expected: VotingProvider already retried once internally.
    const badNameJson = JSON.stringify({ name: 'Amazon.Cart', intent: 'some intent', body: '## body' });
    const provider = fakeVotingProvider([
      { ok: false, error: { kind: 'malformed', raw: badNameJson } },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(false);
  });

  test('name with spaces → rejected by asMergeOk → abstains', async () => {
    // No second call expected: VotingProvider already retried once internally.
    const badNameJson = JSON.stringify({ name: 'amazon cart flow', intent: 'some intent', body: '## body' });
    const provider = fakeVotingProvider([
      { ok: false, error: { kind: 'malformed', raw: badNameJson } },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(false);
  });

  test('malformed raw > 4096 chars with valid merge envelope parses successfully (regression: raw cap)', async () => {
    // Worst-case merge envelope: body(4000) + intent(512) + name(64) + JSON overhead(~50) = ~4626.
    // Round 2 raised the cap to 4096, which still truncates envelopes in this range.
    // Round 3 raised it to 8192. This test uses a ~5500-char body (above 4096, well within 8192)
    // to confirm the recovery path parses envelopes that the previous cap would silently drop.
    const longBody = '## Steps\n' + '1. Click the add-to-cart button\n'.repeat(170); // ~5550 chars
    const envelope = { name: 'amazon.cart-flow', intent: 'Add and buy', body: longBody };
    const raw = JSON.stringify(envelope);
    // Confirm the raw envelope exceeds the old 4096-char cap but fits within 8192.
    expect(raw.length).toBeGreaterThan(4096);
    expect(raw.length).toBeLessThan(8192);
    // The provider returns it as a malformed reply (shape was {name,intent,body} not {action,args}).
    const provider = fakeVotingProvider([
      { ok: false, error: { kind: 'malformed', raw } },
    ]);
    const requester = createLlmMergeRequester({ provider });
    const r = await requester(REQ);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('amazon.cart-flow');
      expect(r.intent).toBe('Add and buy');
      expect(r.body).toContain('Click the add-to-cart button');
    }
  });
});
