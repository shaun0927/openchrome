/**
 * Starter fixture corpus for the Token Efficiency axis (#1256).
 *
 * Three archetypes (e-commerce, news, docs), each a structured fixture built
 * so a deterministic extractor can resolve its >= 12 ground-truth fields —
 * this establishes the baseline measurement path. The full 50-fixture corpus
 * of real-page snapshots and the per-library extraction adapters are later
 * work units of #1256. See RUBRIC.md.
 *
 * Each fixture embeds its ground-truth values as `data-field="KEY"` spans
 * surrounded by realistic noise markup, so raw HTML is much larger than the
 * structured data and the compression ratio is meaningful.
 */

import type { GroundTruthSpec, GroundTruthField } from '../../token-efficiency';

export type FixtureArchetype = 'ecommerce' | 'news' | 'docs';

export interface TokenEfficiencyFixture {
  name: string;
  archetype: FixtureArchetype;
  /** Full HTML document — the raw input every library receives. */
  html: string;
  groundTruth: GroundTruthSpec;
}

/** Realistic noise markup so raw HTML dwarfs the structured payload. */
function noiseBlock(index: number): string {
  return (
    `<div class="noise-row" data-row="${index}">` +
    `<span class="label">Related ${index}</span>` +
    `<p>Supplementary content block ${index} — navigation chrome, tracking ` +
    `markup, and layout wrappers that an LLM does not need.</p>` +
    `<a href="/related/${index}">more ${index}</a></div>`
  );
}

function buildFixtureHtml(
  title: string,
  fields: GroundTruthField[],
  noiseNodes: number,
): string {
  const fieldMarkup = fields
    .map(
      (f) =>
        `<li><span class="field-key">${f.key}</span>` +
        `<span data-field="${f.key}">${f.expected}</span></li>`,
    )
    .join('');
  const noise = Array.from({ length: noiseNodes }, (_, i) => noiseBlock(i)).join('');
  return (
    '<!doctype html><html lang="en"><head>' +
    `<meta charset="utf-8"><title>${title}</title>` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '</head><body>' +
    '<nav class="site-nav"><a href="/">Home</a><a href="/about">About</a></nav>' +
    `<header><h1>${title}</h1></header>` +
    `<main><ul class="fields">${fieldMarkup}</ul>` +
    `<section class="noise">${noise}</section></main>` +
    '<footer><p>fixture footer</p></footer>' +
    '</body></html>'
  );
}

function fixture(
  name: string,
  archetype: FixtureArchetype,
  title: string,
  fields: GroundTruthField[],
  noiseNodes: number,
): TokenEfficiencyFixture {
  return {
    name,
    archetype,
    html: buildFixtureHtml(title, fields, noiseNodes),
    groundTruth: { fixture: name, fields },
  };
}

const ECOMMERCE_FIELDS: GroundTruthField[] = [
  { key: 'title', expected: 'Wireless Headphones' },
  { key: 'price', expected: '$199.00' },
  { key: 'brand', expected: 'Acme Audio' },
  { key: 'sku', expected: 'AA-WH-001' },
  { key: 'rating', expected: '4.6' },
  { key: 'reviewCount', expected: '1283' },
  { key: 'availability', expected: 'In stock' },
  { key: 'primaryCta', expected: 'Add to cart' },
  { key: 'shippingNote', expected: 'Free shipping over $50' },
  { key: 'category', expected: 'Audio' },
  { key: 'color', expected: 'Midnight Black' },
  { key: 'warranty', expected: '2 year limited' },
];

const NEWS_FIELDS: GroundTruthField[] = [
  { key: 'headline', expected: 'City Council Approves Transit Expansion' },
  { key: 'author', expected: 'Jordan Reyes' },
  { key: 'publishedDate', expected: '2026-05-12' },
  { key: 'section', expected: 'Local' },
  { key: 'summary', expected: 'A new light-rail line will connect the east district downtown.' },
  { key: 'wordCount', expected: '842' },
  { key: 'primaryCta', expected: 'Subscribe' },
  { key: 'canonicalUrl', expected: 'https://news.example/transit-expansion' },
  { key: 'category', expected: 'Transportation' },
  { key: 'readingTime', expected: '4 min' },
  { key: 'language', expected: 'en' },
  { key: 'breadcrumb', expected: 'Home / Local / Transportation' },
];

const DOCS_FIELDS: GroundTruthField[] = [
  { key: 'title', expected: 'Configuring the HTTP Transport' },
  { key: 'apiVersion', expected: 'v2' },
  { key: 'category', expected: 'Transports' },
  { key: 'summary', expected: 'How to enable and tune the streamable HTTP transport.' },
  { key: 'lastUpdated', expected: '2026-04-30' },
  { key: 'primaryCta', expected: 'Copy snippet' },
  { key: 'canonicalUrl', expected: 'https://docs.example/http-transport' },
  { key: 'breadcrumb', expected: 'Docs / Transports / HTTP' },
  { key: 'codeLanguage', expected: 'bash' },
  { key: 'language', expected: 'en' },
  { key: 'nextPage', expected: 'Configuring SSE' },
  { key: 'prevPage', expected: 'Transport Overview' },
];

export const TOKEN_EFFICIENCY_CORPUS: readonly TokenEfficiencyFixture[] = [
  fixture('ecommerce-01', 'ecommerce', 'Wireless Headphones', ECOMMERCE_FIELDS, 120),
  fixture('news-01', 'news', 'City Council Approves Transit Expansion', NEWS_FIELDS, 160),
  fixture('docs-01', 'docs', 'Configuring the HTTP Transport', DOCS_FIELDS, 90),
];

/**
 * Deterministic structured extraction baseline — parses the `data-field`
 * spans into a field-keyed record. This is the baseline extraction mode; real
 * per-library extraction adapters are a later work unit. Returns a structured
 * record, never a raw blob, so it is scored fairly by `computeRetention`.
 */
export function deterministicExtract(html: string): Record<string, string> {
  const extracted: Record<string, string> = {};
  const re = /<span data-field="([^"]+)">([^<]*)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    extracted[match[1]] = match[2];
  }
  return extracted;
}
