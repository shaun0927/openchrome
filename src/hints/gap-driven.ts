/**
 * Gap-driven next-action hints.
 *
 * Why this exists
 * ---------------
 * openchrome's HintEngine already fires proactive hints on tool
 * results, but the rules are all pattern-forward — "when tool X
 * returns shape Y, suggest Z". Two upstream projects landed a
 * complementary pattern that runs pattern-backward:
 *
 *  - **qx-labs** — Knowledge-Gap Analyzer computes the delta between
 *    "what the plan needs to answer" and "what the accumulated
 *    results actually cover", then routes the next tool selection
 *    against the gap.
 *  - **Search-o1** — Reason-in-Documents: when a document arrives, ask
 *    "what did this add? what did it *not* add?" and use the
 *    negative side to drive the next action.
 *
 * Both idioms collapse into the same primitive: a `gapAnalyse()` that
 * takes the plan requirements plus the covered evidence and returns
 * the uncovered subset, ranked by importance. openchrome's
 * hint-engine can then call the primitive after each tool result to
 * decide what to suggest next.
 *
 * Design
 * ------
 * - Pure module. Takes plan `requirements` (labelled goals) and
 *   `evidence` (labelled facts already gathered) and returns the
 *   `gaps` — requirement labels not yet covered by evidence, in
 *   descending importance order.
 * - Coverage is decided by a case-insensitive, whitespace-tolerant
 *   overlap between a requirement's `keywords` and any evidence
 *   entry's `keywords`. A requirement is covered when any evidence
 *   entry hits the coverage threshold (default: 1 keyword match).
 * - `nextActionHint(gaps, options)` composes a human-facing hint
 *   from the top gap, respecting a small budget on characters and
 *   optional per-gap templates.
 *
 * Origin credit
 * -------------
 * Shared idiom from qx-labs (Apache-2.0, Knowledge-Gap Analyzer) and
 * Search-o1 (MIT, Reason-in-Documents). Clean-room implementation;
 * no upstream code copied.
 */

export interface Requirement {
  label: string;
  keywords: readonly string[];
  /** 0..1 importance weight. Default 0.5 when omitted. */
  weight?: number;
}

export interface EvidenceItem {
  /** Source id — url, tool call id, document title, etc. */
  source: string;
  keywords: readonly string[];
}

export interface GapAnalysisOptions {
  /** Minimum keyword overlap for coverage. Default 1. */
  minOverlap?: number;
}

export interface GapReport {
  label: string;
  weight: number;
  keywords: readonly string[];
  /** How many evidence items partially matched but fell below minOverlap. */
  partialHits: number;
}

export interface GapAnalysisResult {
  covered: string[];
  gaps: GapReport[];
}

function normaliseKeyword(k: string): string {
  return k.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Compute the coverage delta between plan requirements and gathered
 * evidence. Requirements the evidence hits above threshold move to
 * `covered`; the rest surface as `gaps` sorted by weight desc.
 */
export function gapAnalyse(
  requirements: readonly Requirement[],
  evidence: readonly EvidenceItem[],
  options: GapAnalysisOptions = {},
): GapAnalysisResult {
  const minOverlap = options.minOverlap ?? 1;
  if (minOverlap < 1) {
    throw new RangeError('gapAnalyse: minOverlap must be >= 1');
  }
  const covered: string[] = [];
  const gaps: GapReport[] = [];
  for (const req of requirements) {
    const reqKeywords = new Set(req.keywords.map(normaliseKeyword).filter(Boolean));
    if (reqKeywords.size === 0) continue;
    let bestOverlap = 0;
    let partialHits = 0;
    for (const item of evidence) {
      const itemKeywords = new Set(item.keywords.map(normaliseKeyword).filter(Boolean));
      let overlap = 0;
      for (const k of reqKeywords) if (itemKeywords.has(k)) overlap += 1;
      if (overlap >= minOverlap) {
        bestOverlap = Math.max(bestOverlap, overlap);
      } else if (overlap > 0) {
        partialHits += 1;
      }
    }
    if (bestOverlap >= minOverlap) {
      covered.push(req.label);
    } else {
      gaps.push({
        label: req.label,
        weight: req.weight ?? 0.5,
        keywords: [...reqKeywords],
        partialHits,
      });
    }
  }
  gaps.sort((a, b) => b.weight - a.weight);
  return { covered, gaps };
}

export interface NextActionHintOptions {
  /** Max character length of the returned hint. Default 240. */
  maxChars?: number;
  /**
   * Per-label template. Keys are requirement labels; values are the
   * templated action for that gap. Falls back to the default template
   * when no per-label entry is present.
   */
  templates?: Readonly<Record<string, string>>;
}

/**
 * Compose the caller-facing hint for the top uncovered gap. Returns
 * null when there are no gaps.
 */
export function nextActionHint(
  result: GapAnalysisResult,
  options: NextActionHintOptions = {},
): string | null {
  if (result.gaps.length === 0) return null;
  const top = result.gaps[0];
  const maxChars = options.maxChars ?? 240;
  const template = options.templates?.[top.label]
    ?? `next: cover "${top.label}" — try queries with ${top.keywords.slice(0, 3).map((k) => `"${k}"`).join(', ')}`;
  if (template.length <= maxChars) return template;
  return template.slice(0, Math.max(0, maxChars - 1)) + '…';
}
