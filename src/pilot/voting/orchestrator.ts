/**
 * Multi-model voting orchestrator (Phase 4, replaces #759).
 *
 * Voters vote on the next action a `critical: true` contract should take
 * before the irreversible side-effect fires. A voter can be:
 *   - A deterministic implementation (always-proceed, structural-match, etc.)
 *   - An LLM-backed implementation (ships in `openchrome-perception-voters` #775)
 *
 * The framework is neutral to how a voter produces its reply — it only
 * cares that it conforms to the `Voter` interface. No Anthropic or
 * OpenAI HTTP wrappers are imported here; those belong in the separate
 * `openchrome-perception-voters` package (#775).
 *
 * The runtime calls `vote()` (or `VotingOrchestrator.runVote()`) which:
 *
 *   1. Dispatches the same request to all configured voters in parallel
 *      with `OPENCHROME_VOTING_TIMEOUT_MS` per voter.
 *   2. Parses each reply via `extractFirstJsonObject` — handles
 *      markdown-fenced JSON + leading prose. Failed parse retries once
 *      with a stricter prompt.
 *   3. Adjudicates with `actionsEquivalent` (#711 v2 semantics).
 *   4. On agreement → `{ proceed: true }`.
 *   5. On disagreement → `{ proceed: false, disagreement: {...} }`.
 *   6. Per-session kill switch tracks cumulative voting tokens; once
 *      `OPENCHROME_VOTING_MAX_TOKENS_PER_SESSION` is exceeded, voting
 *      is disabled for the remainder of the session.
 *
 * Gated by `isPerceptionVotingEnabled()` from `src/harness/flags.ts`.
 */

import { isPerceptionVotingEnabled } from '../../harness/flags.js';
import { actionsEquivalent, type ActionInvocation, type EquivalenceContext } from './args-equivalence.js';

export type VoterErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'malformed'
  | 'network'
  | 'unknown';

export interface VoterError {
  kind: VoterErrorKind;
  raw: string;
}

export interface VoteRequest {
  /** Compressed DOM the voters reason about. */
  compressedDom: string;
  /** Path to / inline base64 of the screenshot (voter-specific). */
  screenshotPath?: string;
  /** Skill identity for prompt context. */
  skillName: string;
  /** Operator-supplied intent description. */
  intent: string;
  /** Allowed action kinds — narrows the response surface. */
  allowedActionKinds: string[];
}

export interface VoterReply {
  ok: boolean;
  /** Parsed action when ok === true. */
  action?: ActionInvocation;
  /** Tokens consumed by this voter call (best-effort; 0 for deterministic voters). */
  tokens?: number;
  /** Voter error details when ok === false. */
  error?: VoterError;
}

/**
 * Voter interface — the single contract every voter must satisfy.
 *
 * Implementations can be:
 *   - Deterministic: always-proceed, always-abstain, structural-match, etc.
 *   - LLM-backed: ships in `openchrome-perception-voters` (#775).
 *
 * Tests inject deterministic fakes via the `voters` constructor arg,
 * so the framework is fully testable without API keys.
 */
export interface Voter {
  /** Stable voter identifier — appears in audit + disagreement records. */
  name: string;
  vote(req: VoteRequest, opts: { timeoutMs: number }): Promise<VoterReply>;
}

/**
 * @deprecated Use `Voter` — kept for backward compatibility with code
 * that consumed the old `VotingProvider` name from the closed #759 PR.
 */
export type VotingProvider = Voter;

export interface VotingDisagreement {
  voters: Array<{ name: string; reply: VoterReply }>;
}

export type VoteVerdict =
  | { proceed: true; agreedAction: ActionInvocation; voters: string[] }
  | { proceed: false; reason: 'disagreement' | 'all_failed' | 'kill_switch' | 'disabled'; disagreement?: VotingDisagreement };

export interface VotingPolicy {
  /** Per-voter timeout. Default 5 s. */
  timeoutMs?: number;
  /** Max cumulative tokens per session. Default 10_000. */
  sessionTokenCap?: number;
  /**
   * `strict` → unreachable voter counts as disagreement
   * `graceful` → fall back to single-voter decision
   * Default: `graceful`.
   */
  fallbackMode?: 'strict' | 'graceful';
  /** Equivalence context for actionsEquivalent (host-side target resolver). */
  equivalence?: EquivalenceContext;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SESSION_TOKEN_CAP = 10_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-session token accountant. Wraps a single mutable counter so a
 * VotingOrchestrator can track lifetime cost of voting and surface
 * `kill_switch` when the cap is exceeded.
 *
 * Deterministic voters always report 0 tokens; the budget only activates
 * for LLM-backed voters that report token usage.
 */
export class VotingSessionBudget {
  private tokensUsed = 0;
  private disabled = false;
  private readonly cap: number;

  constructor(cap?: number) {
    this.cap = cap ?? envInt('OPENCHROME_VOTING_MAX_TOKENS_PER_SESSION', DEFAULT_SESSION_TOKEN_CAP);
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  remaining(): number {
    return Math.max(0, this.cap - this.tokensUsed);
  }

  totalUsed(): number {
    return this.tokensUsed;
  }

  /** Charge the budget. Returns true if the new total still fits. */
  charge(tokens: number): boolean {
    if (this.disabled) return false;
    this.tokensUsed += Math.max(0, Math.floor(tokens));
    if (this.tokensUsed > this.cap) {
      this.disabled = true;
      return false;
    }
    return true;
  }
}

export interface VotingOrchestratorOptions extends VotingPolicy {
  voters: Voter[];
  budget?: VotingSessionBudget;
}

/**
 * Extract the first *parseable* balanced-brace JSON object from a
 * free-form string.
 *
 * Voter replies (especially LLM-backed ones) routinely contain
 * explanatory prose alongside (sometimes preceding) the JSON payload.
 * Some prose itself uses braces — `{some prose}`, citation-like `{ref}`
 * markers, etc. The scanner walks every balanced `{...}` segment and
 * tries `JSON.parse` on each; only when no segment parses does it return
 * null. This avoids forcing avoidable `all_failed` / `disagreement`
 * verdicts when a structured payload sits behind a stray brace.
 *
 * Deterministic voters typically skip this entirely by returning a
 * pre-parsed `ActionInvocation` directly in `VoterReply.action`.
 */
export function extractFirstJsonObject(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip markdown fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;

  // Balanced-brace scan: collect every top-level `{...}` slice.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      // Ignore stray closing braces when there is no open one — a `}`
      // before any `{` (markdown templating, prose like `closing }`)
      // would otherwise drive `depth` below zero and prevent every
      // subsequent `{ ... }` segment from ever closing back to depth 0,
      // making `extractFirstJsonObject` miss valid JSON later in the
      // string.
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          // Not valid JSON — keep scanning for a later segment that is.
        }
        start = -1;
      }
    }
  }
  return null;
}

export class VotingOrchestrator {
  private readonly voters: Voter[];
  private readonly timeoutMs: number;
  private readonly fallbackMode: 'strict' | 'graceful';
  private readonly equivalence: EquivalenceContext;
  private readonly budget: VotingSessionBudget;

  constructor(opts: VotingOrchestratorOptions) {
    if (opts.voters.length < 2) {
      // Single-voter voting is meaningless; orchestrator still
      // accepts it so a misconfigured deployment surfaces a `proceed`
      // verdict (no second opinion to disagree) rather than crashing.
    }
    this.voters = opts.voters;
    this.timeoutMs = opts.timeoutMs ?? envInt('OPENCHROME_VOTING_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.fallbackMode = opts.fallbackMode ?? 'graceful';
    this.equivalence = opts.equivalence ?? {};
    this.budget = opts.budget ?? new VotingSessionBudget(opts.sessionTokenCap);
  }

  getBudget(): VotingSessionBudget {
    return this.budget;
  }

  /**
   * Single-voter invocation that absorbs both synchronous throws
   * from the call site (so `Promise.allSettled`'s array-build phase
   * cannot itself throw) and unbounded voter hangs (so the
   * orchestrator enforces its own wall-clock cap regardless of
   * whether the voter honors `timeoutMs`).
   */
  private safeVote(v: Voter, req: VoteRequest): Promise<VoterReply> {
    const votePromise: Promise<VoterReply> = (async () =>
      v.vote(req, { timeoutMs: this.timeoutMs }))();
    const timeoutMs = this.timeoutMs;
    const guard = new Promise<VoterReply>((resolve) => {
      const t = setTimeout(() => {
        resolve({
          ok: false,
          error: { kind: 'timeout', raw: `voter exceeded orchestrator timeout (${timeoutMs}ms)` },
        });
      }, timeoutMs + 100);
      // Allow the process to exit if this is the only thing pending.
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
    });
    return Promise.race([votePromise, guard]);
  }

  async runVote(req: VoteRequest): Promise<VoteVerdict> {
    if (this.budget.isDisabled()) {
      return { proceed: false, reason: 'kill_switch' };
    }

    // Use allSettled so a thrown voter error never aborts the vote
    // — rejections are converted to VoterReply { ok:false } so the
    // normal disagreement / all_failed / strict-fallback paths remain
    // in charge of the verdict. `safeVote` wraps each voter call so
    // (a) synchronous throws during request construction are caught
    // before they escape `Promise.allSettled`'s array-build phase,
    // and (b) the orchestrator enforces its own hard wall-clock
    // timeout — a hung voter that ignores `timeoutMs` cannot block
    // critical-action gating indefinitely.
    const settled = await Promise.allSettled(
      this.voters.map((v) => this.safeVote(v, req)),
    );
    const replies: VoterReply[] = settled.map((r) => {
      if (r.status === 'fulfilled') return normalizeVoterReply(r.value);
      const raw = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { ok: false, error: { kind: 'unknown' as VoterErrorKind, raw } };
    });

    // Charge budget regardless of success.
    let totalTokens = 0;
    for (const r of replies) {
      if (typeof r.tokens === 'number') totalTokens += r.tokens;
    }
    this.budget.charge(totalTokens);

    // Classify replies. A "success" requires both ok=true AND a
    // parsed action — anything short of that (ok=false, OR ok=true
    // without an action object) is a failure.
    const classified = replies.map((r, i) => {
      const isSuccess = r.ok === true && isValidAction(r.action);
      const reply: VoterReply = isSuccess
        ? r
        : r.ok === true
          ? {
              ...r,
              ok: false,
              error: r.error ?? {
                kind: 'malformed' as VoterErrorKind,
                raw: 'voter returned ok without a structurally valid action',
              },
            }
          : r;
      return { name: this.voters[i].name, reply, isSuccess };
    });
    const successes = classified.filter((p) => p.isSuccess);
    const failures = classified.filter((p) => !p.isSuccess);

    if (successes.length === 0) {
      return {
        proceed: false,
        reason: 'all_failed',
        disagreement: { voters: failures },
      };
    }

    // Strict policy: any unreachable voter counts as disagreement.
    if (this.fallbackMode === 'strict' && failures.length > 0) {
      return {
        proceed: false,
        reason: 'disagreement',
        disagreement: {
          voters: [...successes, ...failures],
        },
      };
    }

    // Graceful: adjudicate unanimity across surviving voters.
    const head = successes[0].reply.action!;
    const allAgree = successes.every((s) => safeEquivalent(head, s.reply.action!, this.equivalence));
    if (allAgree) {
      return {
        proceed: true,
        agreedAction: head,
        voters: successes.map((s) => s.name),
      };
    }
    return {
      proceed: false,
      reason: 'disagreement',
      disagreement: { voters: successes },
    };
  }
}

/**
 * Structural validity check for a `VoterReply.action`. Rejecting
 * `{}` or `{ kind: undefined }` here keeps malformed actions from
 * reaching the agreement path with a `proceed: true` verdict.
 */
function isValidAction(a: ActionInvocation | undefined): a is ActionInvocation {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.kind !== 'string' || a.kind.length === 0) return false;
  if (a.args !== undefined && (typeof a.args !== 'object' || a.args === null)) return false;
  return true;
}

function normalizeVoterReply(reply: unknown): VoterReply {
  if (!isVoterReply(reply)) {
    return {
      ok: false,
      error: { kind: 'malformed', raw: 'voter returned a non-object reply' },
    };
  }
  return reply;
}

function isVoterReply(reply: unknown): reply is VoterReply {
  return typeof reply === 'object' && reply !== null &&
    typeof (reply as { ok?: unknown }).ok === 'boolean';
}

/**
 * Crash-proof wrapper around `actionsEquivalent`. A throwing
 * comparator (custom resolver crashes on unexpected input, etc.) is
 * treated as "not equal" — escalation, never `proceed: true`.
 */
function safeEquivalent(
  a: ActionInvocation,
  b: ActionInvocation,
  ctx: EquivalenceContext,
): boolean {
  try {
    return actionsEquivalent(a, b, ctx);
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper: gate on `isPerceptionVotingEnabled()` then
 * delegate to `VotingOrchestrator.runVote()`. Callers that already
 * hold an orchestrator instance can call `runVote()` directly.
 */
export async function vote(
  orchestrator: VotingOrchestrator,
  req: VoteRequest,
): Promise<VoteVerdict> {
  if (!isPerceptionVotingEnabled()) {
    return { proceed: false, reason: 'disabled' };
  }
  return orchestrator.runVote(req);
}
