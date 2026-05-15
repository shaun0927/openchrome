/**
 * deterministic-static extractor — the existing baseline (#1256).
 *
 * Re-tags the existing `deterministicExtract` regex pass as a `library: ...`
 * cell in the matrix so the comparison shows it head-to-head against the
 * other extractors. This is the fastest possible "structured extraction"
 * (a single regex pass over the raw HTML) and acts as the floor for what's
 * achievable when you know exactly which markers to scan for.
 */

import { deterministicExtract } from '../fixtures/token-efficiency/corpus';
import type { Extractor, ExtractorContext, ExtractorResult } from './types';

export const deterministicStaticExtractor: Extractor = {
  library: 'deterministic-static',
  mode: 'regex-data-field',
  liveOnly: false,
  extract(ctx: ExtractorContext): ExtractorResult {
    const extracted = deterministicExtract(ctx.html);
    return {
      extracted,
      payload: JSON.stringify(extracted),
    };
  },
};
