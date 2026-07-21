/**
 * fit-markdown — content-density scoring for markdown extraction.
 *
 * Why this exists
 * ---------------
 * openchrome's semantic extraction path (`src/extraction/semantic.ts`)
 * takes a whole page's HTML-to-markdown conversion and feeds it to the
 * LLM. Real pages are 90% chrome — navigation, footers, cookie banners,
 * suggested-article rails — and the LLM burns tokens skimming to find
 * the 10% that answers the query. Cost, latency, and hallucination
 * risk all follow.
 *
 * crawl4ai's `fit_markdown` strategy solves this: score each markdown
 * block by content density (link vs text ratio, average sentence
 * length, structural signals like headers) and keep only the blocks
 * above a threshold. What survives is roughly "the article" — the
 * dense prose the page is actually about.
 *
 * Design
 * ------
 * - Pure function `computeFitMarkdown(markdown, opts) → FitResult`.
 *   No dependency on puppeteer, DOM, or any network call. Input is a
 *   markdown string (from whatever converter the caller uses).
 * - Splits into blocks on blank lines. Each block gets a `BlockScore`
 *   with sub-scores for link density (lower = better), sentence
 *   length (longer = better), structural bonus (headers keep siblings
 *   in bounds so an article title survives with its lead paragraph),
 *   and length penalty for one-word noise.
 * - The threshold is expressed as a percentile of the block-score
 *   distribution (default: keep top 50%). This is more robust than an
 *   absolute cutoff because "dense" is relative to the page.
 * - Header blocks are always kept when `preserveHeaders: true` (default)
 *   so the structural skeleton survives even if a subheader has no
 *   dense prose under it — the LLM still sees the outline.
 *
 * Origin credit
 * -------------
 * Idiom from crawl4ai (Apache-2.0) — `FitMarkdownGenerator` and
 * `BM25ContentFilter` scoring loop. Clean-room implementation.
 */

export interface FitMarkdownOptions {
  /**
   * Keep blocks whose score is at or above this percentile of the
   * distribution. 0 = keep everything, 100 = keep nothing. Default: 50.
   */
  keepPercentile?: number;
  /**
   * Always keep header blocks (lines starting with `#`) even if their
   * score falls below the percentile. Default: true.
   */
  preserveHeaders?: boolean;
  /**
   * Absolute floor on block character length. Blocks shorter than this
   * are dropped regardless of score. Default: 30.
   */
  minBlockChars?: number;
  /**
   * Blocks with link density above this ratio are penalised heavily
   * (mostly-navigation blocks). Default: 0.5.
   */
  linkDensityCap?: number;
}

export interface BlockScore {
  block: string;
  index: number;
  chars: number;
  linkChars: number;
  linkDensity: number;
  sentenceCount: number;
  isHeader: boolean;
  score: number;
}

export interface FitResult {
  /** The filtered markdown, blocks re-joined by blank lines. */
  markdown: string;
  /** Per-block scoring (all blocks, before filtering). */
  scores: BlockScore[];
  /** Indices of blocks that survived filtering, in original order. */
  keptIndices: number[];
  /** Bytes retained / bytes input. */
  compressionRatio: number;
}

const DEFAULT_OPTS: Required<FitMarkdownOptions> = {
  keepPercentile: 50,
  preserveHeaders: true,
  minBlockChars: 30,
  linkDensityCap: 0.5,
};

/**
 * Split markdown into logical blocks on blank lines. Trailing/leading
 * whitespace is preserved inside blocks so code fences and list
 * indentation survive.
 */
export function splitBlocks(markdown: string): string[] {
  if (typeof markdown !== 'string') {
    throw new TypeError('splitBlocks: markdown must be a string');
  }
  // Normalise CRLF and split on runs of blank lines.
  const normalised = markdown.replace(/\r\n/g, '\n');
  return normalised.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);
}

/** Detect header blocks — first non-empty line starts with `#`. */
export function isHeaderBlock(block: string): boolean {
  const firstLine = block.split('\n', 1)[0] ?? '';
  return /^#{1,6}\s/.test(firstLine);
}

/**
 * Sum characters inside markdown link text `[text](url)`. Used to
 * compute link density — mostly-navigation blocks have high link char
 * ratio.
 */
export function linkCharsIn(block: string): number {
  let total = 0;
  const re = /\[([^\]]+)\]\([^)]+\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    total += m[1].length;
  }
  return total;
}

/** Approximate sentence count via terminator punctuation. */
export function countSentences(block: string): number {
  const stripped = block.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const matches = stripped.match(/[.!?][\s"')\]]|[.!?]$/g);
  const n = matches ? matches.length : 0;
  return Math.max(1, n);
}

/**
 * Score one block. Higher = keep-worthy. The score is unbounded but
 * relative — meaning only comes from comparing scores within a page.
 */
export function scoreBlock(block: string, index: number, opts: Required<FitMarkdownOptions>): BlockScore {
  const chars = block.length;
  const isHeader = isHeaderBlock(block);
  const linkChars = linkCharsIn(block);
  const linkDensity = chars === 0 ? 0 : linkChars / chars;
  const sentenceCount = countSentences(block);
  const avgSentenceLen = chars / sentenceCount;

  // Base score = prose length × sentence-length bonus. Long paragraphs
  // of long sentences dominate. Short lists / short link soup lose.
  let score = chars * Math.log1p(avgSentenceLen);

  // Link density penalty — a block that is >linkDensityCap link chars
  // gets its score halved per point over the cap.
  if (linkDensity > opts.linkDensityCap) {
    const over = linkDensity - opts.linkDensityCap;
    score *= Math.max(0.1, 1 - over * 2);
  }

  // Length penalty — blocks under the floor are all-but-zero.
  if (chars < opts.minBlockChars) {
    score *= 0.1;
  }

  // Header bonus — headers are structurally important beyond their
  // char count, so give them a fixed floor score before percentile
  // selection.
  if (isHeader) {
    score = Math.max(score, 100);
  }

  return {
    block,
    index,
    chars,
    linkChars,
    linkDensity,
    sentenceCount,
    isHeader,
    score,
  };
}

/**
 * Compute the percentile cutoff over a set of numbers. `p` is 0..100.
 * Uses linear interpolation between neighbours.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = ((p / 100) * (sorted.length - 1));
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Top-level fit-markdown extraction. Returns filtered markdown and a
 * full trace of scoring/decisions for observability.
 */
export function computeFitMarkdown(markdown: string, options: FitMarkdownOptions = {}): FitResult {
  const opts = { ...DEFAULT_OPTS, ...options };
  if (opts.keepPercentile < 0 || opts.keepPercentile > 100) {
    throw new RangeError(`keepPercentile must be in [0, 100], got ${opts.keepPercentile}`);
  }
  const blocks = splitBlocks(markdown);
  const scores = blocks.map((b, i) => scoreBlock(b, i, opts));
  if (scores.length === 0) {
    return { markdown: '', scores: [], keptIndices: [], compressionRatio: 0 };
  }
  const cutoff = percentile(scores.map((s) => s.score), opts.keepPercentile);
  const keptIndices: number[] = [];
  for (const s of scores) {
    const keep = s.score >= cutoff || (opts.preserveHeaders && s.isHeader);
    if (keep) keptIndices.push(s.index);
  }
  const kept = keptIndices.map((i) => scores[i].block).join('\n\n');
  const compressionRatio = markdown.length === 0 ? 0 : kept.length / markdown.length;
  return { markdown: kept, scores, keptIndices, compressionRatio };
}
