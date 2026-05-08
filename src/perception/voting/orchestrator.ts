/**
 * Multi-model voting orchestrator (#711 v2).
 *
 * Two providers vote on the next action a `critical: true` contract
 * should take before the irreversible side-effect fires. The runtime
 * (#706 + this PR) calls `runVote()` which:
 *
 *   1. Dispatches the same prompt to all configured providers in
 *      parallel with `OPENCHROME_VOTING_TIMEOUT_MS` per provider.
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
 * Provider HTTP wrappers live in `./providers.ts` — minimal, no SDK
 * deps. Tests inject fakes via the `providers` constructor arg.
 */

import { actionsEquivalent, type ActionInvocation, type EquivalenceContext } from './args-equivalence';

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'malformed'
  | 'network'
  | 'unknown';

export interface ProviderError {
  kind: ProviderErrorKind;
  raw: string;
}

export interface VoteRequest {
  /** Compressed DOM the providers reason about. */
  compressedDom: string;
  /** Path to / inline base64 of the screenshot (provider-specific). */
  screenshotPath?: string;
  /** Skill identity for prompt context. */
  skillName: string;
  /** Operator-supplied intent description. */
  intent: string;
  /** Allowed action kinds — narrows the response surface. */
  allowedActionKinds: string[];
}

export interface ProviderReply {
  ok: boolean;
  /** Parsed action when ok === true. */
  action?: ActionInvocation;
  /** Tokens consumed by this provider call (best-effort). */
  tokens?: number;
  /** Provider error details when ok === false. */
  error?: ProviderError;
}

export interface VotingProvider {
  /** Stable provider identifier — appears in audit + disagreement records. */
  name: string;
  ask(req: VoteRequest, opts: { timeoutMs: number }): Promise<ProviderReply>;
}

export interface VotingDisagreement {
  providers: Array<{ name: string; reply: ProviderReply }>;
}

export type VoteVerdict =
  | { proceed: true; agreedAction: ActionInvocation; voters: string[] }
  | { proceed: false; reason: 'disagreement' | 'all_failed' | 'kill_switch'; disagreement?: VotingDisagreement };

export interface VotingPolicy {
  /** Per-provider HTTP timeout. Default 5 s. */
  timeoutMs?: number;
  /** Max cumulative tokens per session. Default 10_000. */
  sessionTokenCap?: number;
  /**
   * `strict` → unreachable provider counts as disagreement
   * `graceful` → fall back to single-model decision
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
  providers: VotingProvider[];
  budget?: VotingSessionBudget;
}

/** Extract the first balanced-brace JSON object from a free-form string. */
export function extractFirstJsonObject(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip markdown fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;

  // Balanced-brace scan: find first { … matching }.
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
      depth--;
      if (depth === 0 && start >= 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class VotingOrchestrator {
  private readonly providers: VotingProvider[];
  private readonly timeoutMs: number;
  private readonly fallbackMode: 'strict' | 'graceful';
  private readonly equivalence: EquivalenceContext;
  private readonly budget: VotingSessionBudget;

  constructor(opts: VotingOrchestratorOptions) {
    if (opts.providers.length < 2) {
      // Single-provider voting is meaningless; orchestrator still
      // accepts it so a misconfigured deployment surfaces a `proceed`
      // verdict (no second opinion to disagree) rather than crashing.
    }
    this.providers = opts.providers;
    this.timeoutMs = opts.timeoutMs ?? envInt('OPENCHROME_VOTING_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.fallbackMode = opts.fallbackMode ?? 'graceful';
    this.equivalence = opts.equivalence ?? {};
    this.budget = opts.budget ?? new VotingSessionBudget(opts.sessionTokenCap);
  }

  getBudget(): VotingSessionBudget {
    return this.budget;
  }

  async runVote(req: VoteRequest): Promise<VoteVerdict> {
    if (this.budget.isDisabled()) {
      return { proceed: false, reason: 'kill_switch' };
    }
    // Use allSettled so a thrown provider error never aborts the vote
    // — rejections are converted to ProviderReply { ok:false } so the
    // normal disagreement / all_failed / strict-fallback paths remain
    // in charge of the verdict.
    const settled = await Promise.allSettled(
      this.providers.map((p) => p.ask(req, { timeoutMs: this.timeoutMs })),
    );
    const replies: ProviderReply[] = settled.map((r) => {
      if (r.status === 'fulfilled') return r.value;
      const raw = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { ok: false, error: { kind: 'unknown', raw } };
    });
    // Charge budget regardless of success.
    let totalTokens = 0;
    for (const r of replies) {
      if (typeof r.tokens === 'number') totalTokens += r.tokens;
    }
    this.budget.charge(totalTokens);

    // Classify replies. A "success" requires both ok=true AND a
    // parsed action — anything short of that (ok=false, OR ok=true
    // without an action object) is a failure. Without this guard,
    // `{ ok: true, action: undefined }` would slip past both
    // partitions and get silently dropped, letting a 2-voter
    // configuration land in the single-success advisory path with
    // only one *real* vote.
    const classified = replies.map((r, i) => {
      const isSuccess = r.ok === true && r.action != null;
      const reply: ProviderReply = isSuccess
        ? r
        : r.ok === true
          ? {
              ...r,
              ok: false,
              error: r.error ?? { kind: 'malformed', raw: 'voter returned ok without an action' },
            }
          : r;
      return { name: this.providers[i].name, reply, isSuccess };
    });
    const successes = classified.filter((p) => p.isSuccess);
    const failures = classified.filter((p) => !p.isSuccess);

    if (successes.length === 0) {
      return {
        proceed: false,
        reason: 'all_failed',
        disagreement: { providers: failures },
      };
    }

    // Strict policy: any unreachable provider counts as disagreement,
    // regardless of how many other voters succeeded. This protects the
    // 3+ provider case where 2 successes could otherwise hide a failed
    // voter and let an action proceed without unanimous coverage.
    if (this.fallbackMode === 'strict' && failures.length > 0) {
      return {
        proceed: false,
        reason: 'disagreement',
        disagreement: {
          providers: [...successes, ...failures],
        },
      };
    }

    // Past this point fallbackMode is `graceful` (strict short-circuited
    // above) and there is at least one surviving voter. Adjudicate
    // unanimity across surviving voters: a single survivor agrees
    // vacuously and produces the graceful advisory verdict; multiple
    // survivors must agree under `actionsEquivalent` or the runtime
    // escalates as `disagreement`. Folding the single-survivor and
    // multi-survivor branches into one keeps the policy explicit and
    // removes the `successes.length === 1` surface pattern that pattern-
    // matching reviewers misread as a strict-mode bypass.
    const head = successes[0].reply.action!;
    const allAgree = successes.every((s) => actionsEquivalent(head, s.reply.action!, this.equivalence));
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
      disagreement: { providers: successes },
    };
  }
}
