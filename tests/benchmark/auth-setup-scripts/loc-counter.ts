/**
 * LOC counter for the Auth & Real-World Usability axis (#1260).
 *
 * Counting rule committed up front (issue #1260 mandate):
 *   - blank lines excluded
 *   - single-line `//` comments excluded
 *   - block `/* … *\/` comments excluded
 *   - imports counted
 *   - JSDoc / docblock comments excluded
 *
 * One pure function used by the runner + tests; no I/O so the unit test
 * exercises it with literal strings.
 */

export interface LocResult {
  /** Total non-empty source lines after stripping comments. */
  loc: number;
  /** Comment lines (excluded from LOC). */
  commentLines: number;
  /** Blank lines (excluded from LOC). */
  blankLines: number;
  /** Total raw lines in the source. */
  totalLines: number;
}

/**
 * Count the LOC of a single source string. Strips block comments first,
 * then iterates line by line.
 */
export function countLoc(source: string): LocResult {
  // Strip block comments. Replace each block with a single newline so line
  // numbers stay roughly aligned with the original.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '\n');
  const lines = stripped.split('\n');
  let loc = 0;
  let blankLines = 0;
  let commentLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      blankLines += 1;
      continue;
    }
    if (line.startsWith('//')) {
      commentLines += 1;
      continue;
    }
    loc += 1;
  }
  return {
    loc,
    commentLines,
    blankLines,
    totalLines: lines.length,
  };
}
