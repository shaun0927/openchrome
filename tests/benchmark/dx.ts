/**
 * Developer-experience scoring core for the Developer Experience axis (#1261).
 *
 * Two pure, rubric-fixed-up-front scorers (the per-library task scripts and
 * the MCP tool-schema audit are separate work units):
 *
 *   - countSourceLines:        LOC of a task script, comments/blank excluded.
 *   - scoreErrorActionability: 0-3 score for whether a failure's error tells
 *                              an agent what to do next.
 *
 * Both rubrics are defined here, in code, before any measurement — so the
 * metric cannot be retro-fitted to favour a result.
 */

export interface SourceLineCount {
  /** Lines with code after stripping comments and blank lines. */
  code: number;
  /** Lines that are entirely comment. */
  comment: number;
  /** Blank / whitespace-only lines. */
  blank: number;
  /** Raw total line count. */
  total: number;
}

/**
 * Count the lines of code in a source string, cloc-style: comments and blank
 * lines are excluded from `code`. Handles `//` line comments and `/* ... *​/`
 * block comments (including multi-line). `//` or block markers inside string
 * literals are a known, documented edge case — minimal benchmark task scripts
 * do not rely on them, and the rule is applied uniformly to every library.
 */
export function countSourceLines(source: string): SourceLineCount {
  const lines = source.split('\n');
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlockComment = false;

  for (const rawLine of lines) {
    let line = rawLine;
    let sawCode = false;
    let sawComment = false;

    let i = 0;
    while (i < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          sawComment = sawComment || line.slice(i).trim().length > 0;
          i = line.length;
        } else {
          sawComment = true;
          inBlockComment = false;
          i = end + 2;
        }
        continue;
      }
      const blockStart = line.indexOf('/*', i);
      const lineStart = line.indexOf('//', i);
      if (lineStart !== -1 && (blockStart === -1 || lineStart < blockStart)) {
        if (line.slice(i, lineStart).trim().length > 0) sawCode = true;
        sawComment = true;
        i = line.length;
      } else if (blockStart !== -1) {
        if (line.slice(i, blockStart).trim().length > 0) sawCode = true;
        sawComment = true;
        inBlockComment = true;
        i = blockStart + 2;
      } else {
        if (line.slice(i).trim().length > 0) sawCode = true;
        i = line.length;
      }
    }

    if (sawCode) {
      code += 1;
    } else if (sawComment) {
      comment += 1;
    } else {
      blank += 1;
    }
  }

  return { code, comment, blank, total: lines.length };
}

/**
 * The error-actionability rubric, fixed up front. An error is scored 0-3, one
 * point each for whether it surfaces:
 *   1. a cause     — why it failed
 *   2. a location  — where (selector, url, tool, file:line)
 *   3. a next step — what the agent should do about it
 *
 * Keyword sets are deliberately explicit so the rubric is reproducible and
 * applied identically to every library's errors.
 */
export const ACTIONABILITY_RUBRIC = {
  causeKeywords: [
    'because', 'failed', 'not found', 'timeout', 'timed out', 'invalid',
    'missing', 'rejected', 'refused', 'unreachable', 'denied', 'crashed',
  ],
  nextStepKeywords: [
    'try ', 'retry', 'use ', 'check ', 'ensure ', 'did you mean', 'instead',
    'consider ', 'verify ', 'make sure',
  ],
} as const;

export interface ActionabilityScore {
  /** 0-3 total. */
  score: number;
  hasCause: boolean;
  hasLocation: boolean;
  hasNextStep: boolean;
}

/**
 * Score whether a returned error message is actionable for an agent. Pure and
 * deterministic — same input always yields the same score.
 */
export function scoreErrorActionability(error: string): ActionabilityScore {
  const text = error.toLowerCase();

  const hasCause = ACTIONABILITY_RUBRIC.causeKeywords.some((kw) => text.includes(kw));

  // A location is a selector, a url, a file:line, a quoted identifier, or an
  // explicit "at <something>" frame.
  const hasLocation =
    /https?:\/\//.test(error) || // url
    /[.#][a-z][\w-]*/i.test(error) || // css selector
    /\b\w[\w./-]*:\d+/.test(error) || // file:line
    /["'`][^"'`]+["'`]/.test(error) || // quoted identifier
    /\bat\s+\S/.test(text); // stack-frame style

  const hasNextStep = ACTIONABILITY_RUBRIC.nextStepKeywords.some((kw) => text.includes(kw));

  return {
    score: Number(hasCause) + Number(hasLocation) + Number(hasNextStep),
    hasCause,
    hasLocation,
    hasNextStep,
  };
}

/** Mean actionability score over a set of induced-failure errors. */
export function meanActionability(errors: string[]): number {
  if (errors.length === 0) return 0;
  const total = errors.reduce((sum, e) => sum + scoreErrorActionability(e).score, 0);
  return total / errors.length;
}
