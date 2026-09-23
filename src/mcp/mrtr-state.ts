import { createHash, randomBytes, randomUUID } from 'crypto';
import { createRequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';

/**
 * Integrity-protected multi-round-trip (`input_required`) state for the
 * stateless MCP 2026-07-28 era.
 *
 * `requestState` round-trips through the client and is attacker-controlled,
 * and OpenChrome uses client input (for example a confirmation before
 * clearing cookies) to gate side effects. The state is therefore
 * - HMAC-signed with a per-process key and bound to the calling principal
 *   and method (a tampered, expired or re-bound state is rejected by the SDK
 *   with -32602 before the tool runs);
 * - bound to the exact tool/resource and arguments it was issued for, so an
 *   answer given for one request cannot authorize a different one;
 * - single use, so a replayed retry asks again instead of reusing an
 *   earlier confirmation;
 * - the carrier of answers from earlier rounds, because a stateless server
 *   re-runs the tool from its original arguments on every round;
 * - bound to the content of each question: every answer is stored with a
 *   digest of the input request it answered, and is reused only when the
 *   re-run asks exactly the same thing (a confirmation computed from live
 *   state, such as "clear 5 cookies", does not carry over to "clear 12").
 *
 * Only responses to input requests the state itself lists are accepted;
 * `inputResponses` a client sends without being asked are ignored.
 */

export interface MrtrState {
  v: 1;
  target: string;
  argsHash: string;
  nonce: string;
  pending: string[];
  answers: Record<string, unknown>;
  /** Digest of the input request each pending or answered key stood for. */
  digests: Record<string, string>;
}

export interface MrtrRound {
  target: string;
  argsHash: string;
  /** Answers collected in earlier rounds and verified for this request. */
  answers: Record<string, unknown>;
  digests: Record<string, string>;
}

/** Digest of one input request (method and parameters) as the tool asked it. */
export function inputRequestDigest(method: string, params: Record<string, unknown> | undefined): string {
  return createHash('sha256').update(canonicalJson({ method, params: params ?? {} })).digest('base64url');
}

const MAX_STATE_ANSWER_BYTES = 256 * 1024;

export function mrtrStateTtlSeconds(raw = process.env.OPENCHROME_MRTR_STATE_TTL_SECONDS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The request identity a state is bound to: method plus tool name or
 * resource URI, and a hash of the arguments (request `_meta` is excluded;
 * progress tokens legitimately change between rounds).
 */
export function mrtrTarget(method: string, params: Record<string, unknown> | undefined): { target: string; argsHash: string } {
  const name = typeof params?.name === 'string' ? params.name : typeof params?.uri === 'string' ? params.uri : '';
  const args = method === 'tools/call' ? params?.arguments ?? {} : { uri: params?.uri };
  return {
    target: `${method}:${name}`,
    argsHash: createHash('sha256').update(canonicalJson(args)).digest('base64url'),
  };
}

export class MrtrStateManager {
  private readonly consumed = new Map<string, number>();
  readonly codec;

  constructor(
    principalOf: (ctx: ServerContext) => string,
    private readonly options: { ttlSeconds?: number; now?: () => number } = {},
  ) {
    this.codec = createRequestStateCodec<MrtrState>({
      key: randomBytes(32),
      ttlSeconds: this.ttlSeconds(),
      bind: ctx => `${ctx.mcpReq.method}\u0000${principalOf(ctx)}`,
    });
  }

  private ttlSeconds(): number {
    return this.options.ttlSeconds ?? mrtrStateTtlSeconds();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Answers usable by this round. A state for another request, a replayed
   * state, or no state at all yields no answers, so the tool asks again.
   */
  begin(ctx: ServerContext, method: string, params: Record<string, unknown> | undefined): MrtrRound {
    const { target, argsHash } = mrtrTarget(method, params);
    const round: MrtrRound = { target, argsHash, answers: {}, digests: {} };
    const state = ctx.mcpReq.requestState<MrtrState>();
    if (!state || typeof state !== 'object' || state.v !== 1) return round;
    if (state.target !== target || state.argsHash !== argsHash) return round;
    if (!this.consume(state.nonce)) return round;
    const responses = ctx.mcpReq.inputResponses ?? {};
    round.answers = { ...state.answers };
    round.digests = { ...(state.digests ?? {}) };
    for (const key of state.pending) {
      if (Object.prototype.hasOwnProperty.call(responses, key)) round.answers[key] = responses[key];
    }
    return round;
  }

  /**
   * The answer the client gave to exactly this question, if any. An answer
   * recorded for different content is dropped so the question is asked
   * again.
   */
  answerFor(round: MrtrRound, key: string, digest: string): { value: unknown } | undefined {
    if (!Object.prototype.hasOwnProperty.call(round.answers, key)) return undefined;
    if (round.digests[key] === digest) return { value: round.answers[key] };
    delete round.answers[key];
    return undefined;
  }

  /** Seal the state that must accompany the next round's responses. */
  async mint(ctx: ServerContext, round: MrtrRound, pending: Record<string, string>): Promise<string> {
    if (canonicalJson(round.answers).length > MAX_STATE_ANSWER_BYTES) {
      throw new Error('multi-round-trip answers exceed the requestState size limit');
    }
    return await this.codec.mint({
      v: 1,
      target: round.target,
      argsHash: round.argsHash,
      nonce: randomUUID(),
      pending: Object.keys(pending),
      answers: round.answers,
      digests: { ...round.digests, ...pending },
    }, ctx);
  }

  private consume(nonce: unknown): boolean {
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    const now = this.now();
    for (const [seen, expiresAt] of this.consumed) {
      if (expiresAt <= now) this.consumed.delete(seen);
    }
    if (this.consumed.has(nonce)) return false;
    this.consumed.set(nonce, now + this.ttlSeconds() * 1000);
    return true;
  }
}
