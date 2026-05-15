/**
 * crawlee-cheerio extractor (#1256).
 *
 * Crawlee's idiomatic "give me the page payload" mode is
 * `CheerioCrawler`'s requestHandler context — the page HTML parsed by
 * Cheerio. The token-efficiency comparison is for a library's *default*
 * page-extraction output, so for Crawlee we feed the fixture HTML to
 * Cheerio and surface (a) the parsed body text as the LLM payload and
 * (b) a `[data-field]` extraction as the structured retention input.
 *
 * Note: this extractor does NOT spin up a real CheerioCrawler — that would
 * require network plumbing that adds nothing to the metric. Cheerio itself
 * is the parser Crawlee uses internally; calling it directly on the same
 * HTML produces the same output Crawlee would after a request.
 */

import * as cheerio from 'cheerio';

import type { Extractor, ExtractorContext, ExtractorResult } from './types';

export const crawleeCheerioExtractor: Extractor = {
  library: 'crawlee-cheerio',
  mode: 'cheerio-text',
  liveOnly: false,
  extract(ctx: ExtractorContext): ExtractorResult {
    const $ = cheerio.load(ctx.html);
    const extracted: Record<string, string | null> = {};
    for (const field of ctx.groundTruth.fields) {
      const node = $(`[data-field="${field.key}"]`).first();
      extracted[field.key] = node.length > 0 ? node.text() : null;
    }
    // Crawlee's idiomatic LLM payload is the rendered body text.
    const payload = $('body').text().replace(/\s+/g, ' ').trim();
    return { extracted, payload };
  },
};
