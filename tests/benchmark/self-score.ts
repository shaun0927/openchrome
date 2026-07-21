/**
 * Self-scoring (faithfulness-NLI) option for benchmark result grading.
 *
 * Motivation
 * ----------
 * openchrome's benchmark harness currently records task success/failure and
 * throughput/latency/tokens. It does **not** grade whether the extracted
 * content is faithful to the source page. Downstream users cannot answer
 * "did the extractor hallucinate?" without wiring their own grader.
 *
 * This module introduces a *contract* for self-scoring — the evaluation
 * layer that ragas, deepeval, and Vectara HHEM converged on — expressed as
 * a small pluggable interface. The default implementation is a heuristic
 * `LexicalOverlapNliGrader` that requires no external service; production
 * users can plug an NLI model (HHEM, ragas, deepeval) behind the same
 * interface.
 *
 * References
 * ----------
 * - ragas (Apache-2.0) — https://github.com/explodinggradients/ragas
 * - deepeval (Apache-2.0) — https://github.com/confident-ai/deepeval
 * - Vectara HHEM (Apache-2.0) — https://huggingface.co/vectara/hallucination_evaluation_model
 * - trulens/giskard report format — https://github.com/truera/trulens
 *
 * Clean-room re-implementation. No source from the above was copied.
 */

/**
 * The NLI verdict for a single (source, extracted) pair.
 *
 * `supported`   — every claim in the extracted text is present in the source.
 * `contradicted` — at least one claim contradicts the source.
 * `unsupported` — the extracted text contains claims not present in the source.
 * `insufficient` — the source is too small to grade fairly (guardrail).
 */
export type FaithfulnessVerdict =
  | 'supported'
  | 'contradicted'
  | 'unsupported'
  | 'insufficient';

export interface FaithfulnessScore {
  verdict: FaithfulnessVerdict;
  /** 0..1. Higher = more faithful. */
  score: number;
  /** Freeform per-grader details for the report. */
  details?: Record<string, unknown>;
}

export interface FaithfulnessGrader {
  /** Short id used in the benchmark report (e.g. `lexical-nli`, `hhem`). */
  readonly id: string;
  /** Human-friendly label. */
  readonly label: string;
  grade(
    source: string,
    extracted: string,
  ): Promise<FaithfulnessScore> | FaithfulnessScore;
}

/**
 * Heuristic default grader — token-overlap-based approximation of an NLI
 * classifier. Cheap, deterministic, no external dependency. Suitable as a
 * baseline; production runs should plug a real NLI model.
 */
export class LexicalOverlapNliGrader implements FaithfulnessGrader {
  readonly id = 'lexical-nli';
  readonly label = 'Lexical Overlap (baseline)';

  private readonly minSourceTokens: number;
  private readonly supportThreshold: number;
  private readonly contradictionThreshold: number;

  constructor(opts?: {
    minSourceTokens?: number;
    supportThreshold?: number;
    contradictionThreshold?: number;
  }) {
    this.minSourceTokens = opts?.minSourceTokens ?? 5;
    this.supportThreshold = opts?.supportThreshold ?? 0.7;
    this.contradictionThreshold = opts?.contradictionThreshold ?? 0.3;
  }

  grade(source: string, extracted: string): FaithfulnessScore {
    const srcTokens = tokenize(source);
    const extTokens = tokenize(extracted);

    if (srcTokens.size < this.minSourceTokens) {
      return {
        verdict: 'insufficient',
        score: 0,
        details: { srcTokens: srcTokens.size, minRequired: this.minSourceTokens },
      };
    }
    if (extTokens.size === 0) {
      return {
        verdict: 'insufficient',
        score: 0,
        details: { extTokens: 0 },
      };
    }

    let matched = 0;
    for (const t of extTokens) {
      if (srcTokens.has(t)) matched++;
    }
    const score = matched / extTokens.size;

    let verdict: FaithfulnessVerdict;
    if (score >= this.supportThreshold) verdict = 'supported';
    else if (score < this.contradictionThreshold) verdict = 'contradicted';
    else verdict = 'unsupported';

    return {
      verdict,
      score,
      details: {
        matched,
        extTokens: extTokens.size,
        srcTokens: srcTokens.size,
      },
    };
  }
}

function tokenize(text: string): Set<string> {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return new Set();
  return new Set(clean.split(' ').filter((t) => t.length > 1));
}

/**
 * The self-scoring evaluation report envelope. Modelled loosely on the
 * trulens/giskard evaluation report shape so downstream tools can consume it
 * without a bespoke schema.
 */
export interface SelfScoreReport {
  grader: string;
  graderLabel: string;
  generatedAt: string;
  summary: {
    total: number;
    supported: number;
    contradicted: number;
    unsupported: number;
    insufficient: number;
    /** Mean score across grade-able entries (excludes `insufficient`). */
    meanScore: number;
  };
  entries: Array<{
    id: string;
    verdict: FaithfulnessVerdict;
    score: number;
    details?: Record<string, unknown>;
  }>;
}

export interface SelfScoreInput {
  id: string;
  source: string;
  extracted: string;
}

/**
 * Run a grader across a batch of (source, extracted) pairs and return the
 * evaluation report envelope. Order of entries is preserved.
 */
export async function runSelfScore(
  grader: FaithfulnessGrader,
  batch: SelfScoreInput[],
): Promise<SelfScoreReport> {
  const entries: SelfScoreReport['entries'] = [];
  let supported = 0;
  let contradicted = 0;
  let unsupported = 0;
  let insufficient = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  for (const item of batch) {
    const result = await grader.grade(item.source, item.extracted);
    entries.push({
      id: item.id,
      verdict: result.verdict,
      score: result.score,
      details: result.details,
    });
    switch (result.verdict) {
      case 'supported':
        supported++;
        scoreSum += result.score;
        scoreCount++;
        break;
      case 'contradicted':
        contradicted++;
        scoreSum += result.score;
        scoreCount++;
        break;
      case 'unsupported':
        unsupported++;
        scoreSum += result.score;
        scoreCount++;
        break;
      case 'insufficient':
        insufficient++;
        break;
    }
  }

  return {
    grader: grader.id,
    graderLabel: grader.label,
    generatedAt: new Date().toISOString(),
    summary: {
      total: batch.length,
      supported,
      contradicted,
      unsupported,
      insufficient,
      meanScore: scoreCount > 0 ? scoreSum / scoreCount : 0,
    },
    entries,
  };
}
