/**
 * Token-efficiency extractor registry (#1256).
 *
 * The matrix runner imports `ALL_EXTRACTORS` and drives every cell against
 * every fixture. Order is stable — drives the row order in the result
 * envelope and the column order in the report.
 */

import type { Extractor } from './types';
import { deterministicStaticExtractor } from './deterministic-static';
import { crawleeCheerioExtractor } from './crawlee-cheerio';
import { liveOnlyExtractors } from './live-only';

export type { Extractor, ExtractorContext, ExtractorResult, CellOutcome, SkippedCell, RunCell } from './types';

export const ALL_EXTRACTORS: readonly Extractor[] = [
  deterministicStaticExtractor,
  crawleeCheerioExtractor,
  ...liveOnlyExtractors,
];
