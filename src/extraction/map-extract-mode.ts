/**
 * Map / Extract mode contract (firecrawl idiom, clean-room).
 *
 * openchrome already ships `scrape`-style extraction (`fast` / `standard` /
 * `semantic`). Users who want to do *multi-page* work — enumerate every URL
 * under a domain (`map`) or pull a structured record out of one page via a
 * schema (`extract`) — currently have to compose that on top of the base
 * extractor themselves.
 *
 * firecrawl (AGPL-3.0) popularised a three-endpoint model:
 *
 *   scrape   — single page → markdown/text (openchrome has this).
 *   map      — one URL → enumerated list of same-domain URLs, filtered.
 *   extract  — one URL + schema → structured JSON matching the schema.
 *
 * This module contributes the **contract** for map + extract. It does not
 * copy firecrawl source; the interfaces, options, validation, and JSON
 * result envelopes here are a clean-room re-derivation of the documented
 * endpoint shape. A default `simpleUrlMapper` implementation ships as a
 * zero-dependency baseline; production users can plug crawl4ai /
 * firecrawl / a custom crawler behind the same interface.
 *
 * Reference: firecrawl docs (map, extract endpoints).
 * Origin credit: the three-mode split originates in firecrawl.
 */

/**
 * The three modes contributed by this pack (`scrape` already exists in
 * openchrome — it lives in `mode.ts` under `fast/standard/semantic`).
 */
export type CrawlMode = 'scrape' | 'map' | 'extract';

export const CRAWL_MODES: readonly CrawlMode[] = ['scrape', 'map', 'extract'];

/**
 * Options for the `map` mode — enumerate URLs reachable from a seed URL.
 * Kept intentionally small so third-party mappers can honour a common
 * contract without a monster options bag.
 */
export interface MapModeOptions {
  /** Maximum URLs to return. Defaults to 5000 to match firecrawl. */
  limit?: number;
  /** If true, restricts results to the seed's registrable domain. */
  sameDomainOnly?: boolean;
  /** If true, restricts results to subpaths of the seed URL. */
  subpathsOnly?: boolean;
  /** Optional include patterns (glob-like, `*` = any run of chars). */
  includePatterns?: string[];
  /** Optional exclude patterns. Applied after includePatterns. */
  excludePatterns?: string[];
  /** If true, follow sitemap.xml when present. */
  useSitemap?: boolean;
}

export interface MapModeResult {
  seed: string;
  urls: string[];
  /** Where each URL was discovered: `sitemap`, `dom`, or `heuristic`. */
  sources: Record<string, MapUrlSource>;
  /** True when the mapper truncated the result at `limit`. */
  truncated: boolean;
}

export type MapUrlSource = 'sitemap' | 'dom' | 'heuristic';

export interface UrlMapper {
  readonly id: string;
  readonly label: string;
  map(seed: string, options?: MapModeOptions): Promise<MapModeResult>;
}

/**
 * Options for the `extract` mode — pull a structured record out of a page
 * using a JSON-schema-like descriptor. The full JSON Schema spec is not
 * required — the extractor only needs the shape and required fields.
 */
export interface ExtractModeOptions<S extends ExtractSchema = ExtractSchema> {
  schema: S;
  /** Optional free-text hint to the extractor (e.g. "the pricing table"). */
  hint?: string;
  /** Hard cap on tokens the extractor may spend. Defaults to 4000. */
  maxTokens?: number;
}

export interface ExtractSchema {
  type: 'object';
  properties: Record<string, ExtractSchemaField>;
  required?: string[];
}

export type ExtractSchemaField =
  | { type: 'string'; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: ExtractSchemaField; description?: string }
  | { type: 'object'; properties: Record<string, ExtractSchemaField>; description?: string };

export interface ExtractModeResult<T = Record<string, unknown>> {
  url: string;
  data: T;
  /** True when every `required` field in the schema was populated. */
  complete: boolean;
  /** Fields that could not be filled. Empty when `complete === true`. */
  missing: string[];
  /** Optional per-field confidence 0..1. */
  confidence?: Record<string, number>;
}

export interface StructuredExtractor {
  readonly id: string;
  readonly label: string;
  extract<T = Record<string, unknown>>(
    url: string,
    pageContent: string,
    options: ExtractModeOptions,
  ): Promise<ExtractModeResult<T>>;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateMapOptions(opts: MapModeOptions | undefined): ValidationResult {
  if (!opts) return { ok: true };
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
      return { ok: false, error: 'limit must be a positive integer' };
    }
    if (opts.limit > 50000) {
      return { ok: false, error: 'limit exceeds hard cap of 50000' };
    }
  }
  if (opts.includePatterns) {
    for (const p of opts.includePatterns) {
      if (typeof p !== 'string' || p.length === 0) {
        return { ok: false, error: 'includePatterns entries must be non-empty strings' };
      }
    }
  }
  return { ok: true };
}

export function validateExtractSchema(schema: ExtractSchema): ValidationResult {
  if (!schema || schema.type !== 'object') {
    return { ok: false, error: 'schema.type must be "object"' };
  }
  if (!schema.properties || typeof schema.properties !== 'object') {
    return { ok: false, error: 'schema.properties is required' };
  }
  if (Object.keys(schema.properties).length === 0) {
    return { ok: false, error: 'schema.properties must have at least one field' };
  }
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in schema.properties)) {
        return { ok: false, error: `required field "${field}" not in properties` };
      }
    }
  }
  return { ok: true };
}

/**
 * Compile a firecrawl-style glob (`*` wildcard, literal everything else) to
 * a RegExp. Anchored at both ends. Kept deliberately small — full glob
 * grammar is not required for URL filtering.
 */
export function compileUrlPattern(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((chunk) => chunk.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// Baseline UrlMapper — DOM anchor sweep, no external deps
// ---------------------------------------------------------------------------

/**
 * Minimal in-process URL mapper. Given the raw HTML of the seed page and
 * the seed URL, enumerates same-domain `<a href>` targets. Intended as the
 * zero-dependency baseline; a real crawler can extend the contract.
 *
 * Exported alongside the interfaces so callers can smoke-test without
 * pulling in an external crawler.
 */
export function extractLinksFromHtml(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /<a\s[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  const baseUrl = safeUrl(base);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) {
      continue;
    }
    try {
      const url = baseUrl ? new URL(raw, baseUrl).toString() : new URL(raw).toString();
      out.add(url);
    } catch {
      // Skip malformed hrefs
    }
  }
  return Array.from(out);
}

function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function filterUrls(
  urls: string[],
  seed: string,
  options: MapModeOptions | undefined,
): string[] {
  const seedUrl = safeUrl(seed);
  const includes = (options?.includePatterns ?? []).map(compileUrlPattern);
  const excludes = (options?.excludePatterns ?? []).map(compileUrlPattern);
  const out: string[] = [];
  for (const raw of urls) {
    const url = safeUrl(raw);
    if (!url) continue;
    if (options?.sameDomainOnly && seedUrl && url.hostname !== seedUrl.hostname) continue;
    if (options?.subpathsOnly && seedUrl && !url.pathname.startsWith(seedUrl.pathname)) continue;
    if (includes.length && !includes.some((re) => re.test(raw))) continue;
    if (excludes.some((re) => re.test(raw))) continue;
    out.push(raw);
  }
  return out;
}

/**
 * A synchronous, in-process URL mapper. Callers that need to fetch the seed
 * page over the network should wrap this with their own fetcher and pass
 * the resulting HTML in.
 */
export class SimpleUrlMapper implements UrlMapper {
  readonly id = 'simple';
  readonly label = 'Simple DOM Mapper';

  constructor(
    private readonly fetcher: (url: string) => Promise<string>,
  ) {}

  async map(seed: string, options?: MapModeOptions): Promise<MapModeResult> {
    const validation = validateMapOptions(options);
    if (!validation.ok) {
      throw new Error(`Invalid map options: ${validation.error}`);
    }
    const limit = options?.limit ?? 5000;
    const html = await this.fetcher(seed);
    const raw = extractLinksFromHtml(html, seed);
    const filtered = filterUrls(raw, seed, options);
    const truncated = filtered.length > limit;
    const urls = truncated ? filtered.slice(0, limit) : filtered;
    const sources: Record<string, MapUrlSource> = {};
    for (const u of urls) sources[u] = 'dom';
    return { seed, urls, sources, truncated };
  }
}

/**
 * Utility: check whether an ExtractModeResult satisfies the schema's
 * `required` fields, and populate `missing`/`complete`. Used by production
 * `StructuredExtractor` implementations so they don't reinvent this check.
 */
export function finaliseExtractResult<T extends Record<string, unknown>>(
  url: string,
  data: T,
  schema: ExtractSchema,
  confidence?: Record<string, number>,
): ExtractModeResult<T> {
  const missing: string[] = [];
  for (const key of schema.required ?? []) {
    const v = (data as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === '') missing.push(key);
  }
  return {
    url,
    data,
    complete: missing.length === 0,
    missing,
    confidence,
  };
}
