/**
 * Playwright fixture-backed token-efficiency extractors (#1256).
 *
 * `page.content()` returns the full HTML document, and `locator('body')` /
 * `innerText()` returns rendered body text. For the frozen local fixtures the
 * input HTML is already the byte-identical page body every library receives, so
 * these two Playwright baselines can run deterministically without launching
 * Chrome. The a11y snapshot remains live-only because it depends on Chromium's
 * accessibility tree implementation.
 */

import * as cheerio from 'cheerio';

import type { Extractor, ExtractorContext, ExtractorResult } from './types';

function fieldExtraction($: cheerio.CheerioAPI, ctx: ExtractorContext): Record<string, string | null> {
  const extracted: Record<string, string | null> = {};
  for (const field of ctx.groundTruth.fields) {
    const node = $(`[data-field="${field.key}"]`).first();
    extracted[field.key] = node.length > 0 ? node.text() : null;
  }
  return extracted;
}

export const playwrightContentExtractor: Extractor = {
  library: 'playwright-content',
  mode: 'raw-html',
  liveOnly: false,
  extract(ctx: ExtractorContext): ExtractorResult {
    const $ = cheerio.load(ctx.html);
    return {
      extracted: fieldExtraction($, ctx),
      payload: ctx.html,
    };
  },
};

export const playwrightInnerTextExtractor: Extractor = {
  library: 'playwright-innertext',
  mode: 'innerText',
  liveOnly: false,
  extract(ctx: ExtractorContext): ExtractorResult {
    const $ = cheerio.load(ctx.html);
    return {
      extracted: fieldExtraction($, ctx),
      payload: $('body').text().replace(/\s+/g, ' ').trim(),
    };
  },
};
