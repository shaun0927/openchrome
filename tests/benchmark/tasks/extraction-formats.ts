import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { countTokens } from '../utils/tokenizer';

export interface ExtractionFormatEntry {
  fixture: string;
  mode: string;
  wallTimeMs: number;
  inputChars: number;
  outputChars: number;
  /** Exact token count of the output payload (cl100k_base via js-tiktoken). */
  tokens: number;
  fieldsFound: number;
  fieldsTotal: number;
  fallbackUsed: boolean;
  recipeUsed: boolean;
  contentMutated: boolean;
  skippedReason?: string;
}

export interface ExtractionFormatsReport {
  generatedAt: string;
  ciMode: boolean;
  entries: ExtractionFormatEntry[];
  summary: {
    fixtures: number;
    modes: number;
    failures: number;
  };
}

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'extraction');
const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'extraction-formats.json');

export interface ExtractionWorkingDocument {
  html: string;
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, '');
}

function textOnly(html: string): string {
  return stripNoise(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deterministicExtract(html: string): { fieldsFound: number; fieldsTotal: number; output: string } {
  const fieldsTotal = 3;
  const data: Record<string, unknown> = { title: null, price: null, image: null };
  const jsonLd = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (jsonLd) {
    try {
      const parsed = JSON.parse(jsonLd);
      data.title = parsed.name || parsed.headline || null;
      data.price = parsed.price || parsed.offers?.price || null;
      data.image = parsed.image || null;
    } catch {
      // fixture benchmark ignores malformed JSON-LD
    }
  }
  data.title ||= html.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, '') || null;
  data.price ||= html.match(/class="[^"]*price[^"]*"[^>]*>(.*?)<\//i)?.[1]?.replace(/<[^>]+>/g, '') || null;
  data.image ||= html.match(/<img[^>]+src="([^"]+)"/i)?.[1] || null;
  const fieldsFound = Object.values(data).filter(Boolean).length;
  return { fieldsFound, fieldsTotal, output: JSON.stringify({ data, fieldsFound, fieldsTotal }) };
}

function measure<T>(fn: () => T): { value: T; wallTimeMs: number } {
  const start = process.hrtime.bigint();
  const value = fn();
  const end = process.hrtime.bigint();
  return { value, wallTimeMs: Number(end - start) / 1_000_000 };
}

export function measureExtractionTransform<T>(
  sourceHtml: string,
  fn: (document: ExtractionWorkingDocument) => T,
): { value: T; wallTimeMs: number; contentMutated: boolean } {
  const before = checksum(sourceHtml);
  const document: ExtractionWorkingDocument = { html: sourceHtml };
  const measured = measure(() => fn(document));
  return {
    ...measured,
    contentMutated: checksum(document.html) !== before,
  };
}

export function runExtractionFormatsBenchmark(options: { ciMode?: boolean } = {}): ExtractionFormatsReport {
  const fixtureNames = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.html')).sort();
  const entries: ExtractionFormatEntry[] = [];

  for (const fixture of fixtureNames) {
    const fixturePath = path.join(FIXTURE_DIR, fixture);
    const html = fs.readFileSync(fixturePath, 'utf8');

    const dom = measureExtractionTransform(html, document => stripNoise(document.html));
    entries.push({
      fixture,
      mode: 'dom_compact_static',
      wallTimeMs: dom.wallTimeMs,
      inputChars: html.length,
      outputChars: dom.value.length,
      tokens: countTokens(dom.value),
      fieldsFound: 0,
      fieldsTotal: 0,
      fallbackUsed: false,
      recipeUsed: false,
      contentMutated: dom.contentMutated,
    });

    const extracted = measureExtractionTransform(html, document => deterministicExtract(document.html));
    entries.push({
      fixture,
      mode: 'extract_data_deterministic_static',
      wallTimeMs: extracted.wallTimeMs,
      inputChars: html.length,
      outputChars: extracted.value.output.length,
      tokens: countTokens(extracted.value.output),
      fieldsFound: extracted.value.fieldsFound,
      fieldsTotal: extracted.value.fieldsTotal,
      fallbackUsed: false,
      recipeUsed: false,
      contentMutated: extracted.contentMutated,
    });

    const readable = measureExtractionTransform(html, document => textOnly(document.html));
    entries.push({
      fixture,
      mode: 'readable_text_static',
      wallTimeMs: readable.wallTimeMs,
      inputChars: html.length,
      outputChars: readable.value.length,
      tokens: countTokens(readable.value),
      fieldsFound: 0,
      fieldsTotal: 0,
      fallbackUsed: false,
      recipeUsed: false,
      contentMutated: readable.contentMutated,
    });

    for (const mode of ['markdown_clean_openchrome', 'recipe_auto_openchrome', 'llm_fallback_mock']) {
      entries.push({
        fixture,
        mode,
        wallTimeMs: 0,
        inputChars: html.length,
        outputChars: 0,
        tokens: 0,
        fieldsFound: 0,
        fieldsTotal: 0,
        fallbackUsed: mode === 'llm_fallback_mock',
        recipeUsed: mode === 'recipe_auto_openchrome',
        contentMutated: false,
        skippedReason: 'feature not available in this benchmark baseline; enable when corresponding issue lands',
      });
    }
  }

  const report: ExtractionFormatsReport = {
    generatedAt: new Date().toISOString(),
    ciMode: Boolean(options.ciMode),
    entries,
    summary: {
      fixtures: fixtureNames.length,
      modes: new Set(entries.map(e => e.mode)).size,
      failures: entries.filter(e => e.contentMutated).length,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n');
  return report;
}

export function formatExtractionFormatsReport(report: ExtractionFormatsReport): string {
  const lines = ['Extraction format benchmark', 'fixture,mode,outputChars,tokens,fields,mutated,skip'];
  for (const e of report.entries) {
    lines.push([
      e.fixture,
      e.mode,
      e.outputChars,
      e.tokens,
      `${e.fieldsFound}/${e.fieldsTotal}`,
      e.contentMutated,
      e.skippedReason || '',
    ].join(','));
  }
  return lines.join('\n');
}
