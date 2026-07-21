/**
 * RARR-style post-hoc revise hook.
 *
 * Classic recovery in openchrome is "detect failure → propose retry
 * candidate". That is the *prevention* mode: try to avoid the wrong answer.
 * RARR (Retrofit Attribution using Research and Revision, Gao et al.) makes
 * the opposite bet — assume the initial answer will land, then use a
 * cheaper revise pass to patch specific claims that fail post-hoc
 * verification.
 *
 * In an openchrome context this maps to a common pattern: an extraction
 * strategy returns a plausible-looking payload, but downstream schema
 * validation, tests, or a human review flag a specific field as wrong.
 * Instead of throwing away the whole result and re-running the extractor,
 * we invoke a `revise` hook that only rewrites the flagged fields.
 *
 * Contract
 * --------
 *   const revise = createReviseHook({
 *     revisers: {
 *       'schema-violation': async ({ payload, findings }) => ({ ... }),
 *       'stale-value':      async ({ payload, findings }) => ({ ... }),
 *     },
 *   });
 *   const outcome = await revise({
 *     payload: originalResult,
 *     findings: [{ kind: 'schema-violation', locus: 'invoice.total', ... }],
 *   });
 *   if (outcome.status === 'revised') use(outcome.payload);
 *
 * The hook itself owns *only* the dispatch policy. Concrete revisers are
 * caller-supplied — they are the ones that know how to patch a given
 * failure class. This keeps this module dependency-free and testable in
 * isolation.
 *
 * Clean-room. Idea attribution per docs/rebirth/ULTIMATE-CENSUS-2026-07-18:
 * RARR (B13). No code copied.
 */

export interface ReviseFinding {
  kind: string;
  locus: string;
  detail?: string;
}

export interface ReviseRequest<TPayload> {
  payload: TPayload;
  findings: readonly ReviseFinding[];
  /** Optional session id for logging / cache keying. */
  sessionId?: string;
}

export interface ReviseAppliedPatch {
  kind: string;
  locus: string;
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
}

export type ReviseResult<TPayload> =
  | { status: 'no-findings'; payload: TPayload; patches: readonly ReviseAppliedPatch[] }
  | { status: 'revised'; payload: TPayload; patches: readonly ReviseAppliedPatch[] }
  | {
      status: 'unrecoverable';
      payload: TPayload;
      patches: readonly ReviseAppliedPatch[];
      reason: string;
    };

export interface ReviserContext<TPayload> {
  payload: TPayload;
  finding: ReviseFinding;
  allFindings: readonly ReviseFinding[];
  sessionId?: string;
}

export type Reviser<TPayload> = (
  ctx: ReviserContext<TPayload>,
) => Promise<TPayload | null>;

export interface ReviseHookOptions<TPayload> {
  revisers: Readonly<Record<string, Reviser<TPayload>>>;
  /**
   * Maximum number of findings to attempt per call. Guards against a runaway
   * finding stream from a broken classifier. Default 16.
   */
  maxFindings?: number;
  /**
   * If true, a reviser that returns `null` marks the finding as `skipped`
   * (default). If false, `null` marks it as `failed`, which can escalate to
   * `unrecoverable`.
   */
  nullMeansSkip?: boolean;
}

export interface ReviseHook<TPayload> {
  (request: ReviseRequest<TPayload>): Promise<ReviseResult<TPayload>>;
}

/**
 * Build a revise hook. Pure factory — the returned hook holds no state.
 */
export function createReviseHook<TPayload>(
  options: ReviseHookOptions<TPayload>,
): ReviseHook<TPayload> {
  const maxFindings = Math.max(1, options.maxFindings ?? 16);
  const nullMeansSkip = options.nullMeansSkip ?? true;
  return async (request) => {
    if (request.findings.length === 0) {
      return { status: 'no-findings', payload: request.payload, patches: [] };
    }
    const applied: ReviseAppliedPatch[] = [];
    let current = request.payload;
    const cappedFindings = request.findings.slice(0, maxFindings);
    let anyApplied = false;
    let anyFailed = false;
    for (const finding of cappedFindings) {
      const reviser = options.revisers[finding.kind];
      if (!reviser) {
        applied.push({ kind: finding.kind, locus: finding.locus, status: 'skipped', reason: 'no-reviser' });
        continue;
      }
      try {
        const next = await reviser({
          payload: current,
          finding,
          allFindings: cappedFindings,
          sessionId: request.sessionId,
        });
        if (next === null || next === undefined) {
          applied.push({
            kind: finding.kind,
            locus: finding.locus,
            status: nullMeansSkip ? 'skipped' : 'failed',
            reason: nullMeansSkip ? 'reviser-null' : 'reviser-returned-null',
          });
          if (!nullMeansSkip) anyFailed = true;
          continue;
        }
        current = next;
        applied.push({ kind: finding.kind, locus: finding.locus, status: 'applied' });
        anyApplied = true;
      } catch (error) {
        applied.push({
          kind: finding.kind,
          locus: finding.locus,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
        anyFailed = true;
      }
    }
    if (!anyApplied && anyFailed) {
      return {
        status: 'unrecoverable',
        payload: current,
        patches: applied,
        reason: 'all-revisers-failed',
      };
    }
    return { status: 'revised', payload: current, patches: applied };
  };
}
