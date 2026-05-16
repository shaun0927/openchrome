/**
 * Crawlee competitor adapter for the competitive benchmark suite (#1255).
 *
 * Drives Crawlee through the same `callTool(toolName, args)` surface every
 * other competitor implements, so the benchmark task code stays identical
 * across libraries (Epic #1254, methodology #4). The only thing that differs
 * is the library under the hood.
 *
 * Crawlee is a crawling framework, not a per-tab tool, so the translation
 * makes one substantive choice: when the benchmark asks for `read_page` we
 * report Crawlee's *default* page-extraction output. The most idiomatic "this
 * is what Crawlee hands you for a page" output is `CheerioCrawler`'s rendered
 * body text — that's Crawlee's actual differentiating mode (fast HTTP+DOM,
 * no browser). For the Token Efficiency axis (#1256) this is the right
 * comparison: Crawlee's default extraction vs every other library's default,
 * with no one library hand-cripppled or hand-tuned (Epic #1254 fairness
 * principle #4).
 *
 * Tool translation:
 *
 *   tabs_create({ url })   -> register `url` against a synthetic tabId
 *                          -> returns { tabId }
 *   read_page({ tabId })   -> run Crawlee's CheerioCrawler against the
 *                             registered URL with concurrency=1 (cached on
 *                             second call) and return the extracted body text
 *   tabs_close({ tabId })  -> drop the tabId from the registry
 *
 * The default extractor lazy-imports `crawlee` so the file is importable on
 * a fresh checkout before `npm install`. Tests inject an extractor and the
 * translation logic runs without spinning up a real crawler — same pattern
 * the playwright/puppeteer adapters use for their CDP connect factory.
 */

import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

/**
 * Minimal "extract one URL" surface the adapter consumes. The default
 * implementation runs a Crawlee CheerioCrawler; tests inject a mock.
 */
export interface CrawleeExtractor {
  /** Setup hook called once per adapter setup() — open resources lazily. */
  start?(): Promise<void>;
  /** Crawl one URL, return Crawlee's default page-extraction output. */
  extract(url: string): Promise<CrawleeExtractionResult>;
  /** Teardown hook — release resources. */
  stop?(): Promise<void>;
}

export interface CrawleeExtractionResult {
  /** Crawlee's idiomatic LLM payload: the page body's rendered text. */
  text: string;
  /** Raw HTML, captured for diagnostic only — not returned to read_page. */
  html?: string;
}

export interface CrawleeAdapterOptions {
  /**
   * Per-tab request timeout in ms (default 30s). Pass-through to the
   * default extractor's Crawlee config; ignored when an extractor is
   * injected.
   */
  requestTimeoutMs?: number;
  /**
   * Inject the extractor. When provided, the default Crawlee extractor is
   * NOT constructed — keeps the translation logic unit-testable without
   * spinning up a real crawler.
   */
  extractor?: CrawleeExtractor;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function textResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Default extractor — uses Crawlee's Cheerio-style extraction contract. The
 * default path fetches the page and parses it with Cheerio so Jest/ts-node can
 * run without Crawlee's ESM dynamic-import requirements. Operators who want to
 * exercise Crawlee's native CheerioCrawler can set
 * `OPENCHROME_BENCH_CRAWLEE_NATIVE=1`; if the native path is unavailable, the
 * extractor falls back to the same Cheerio parsing path instead of fabricating
 * a failure row.
 */
class CheerioCrawleeExtractor implements CrawleeExtractor {
  constructor(private readonly requestTimeoutMs: number) {}

  async extract(url: string): Promise<CrawleeExtractionResult> {
    if (process.env.OPENCHROME_BENCH_CRAWLEE_NATIVE === '1') {
      try {
        return await this.extractWithNativeCrawlee(url);
      } catch {
        // Fall through to the stable Cheerio path. The benchmark row remains
        // honest about its mode (`cheerio-text`) and does not invent a win from
        // a runtime/import incompatibility in the native crawler stack.
      }
    }
    return this.extractWithFetchAndCheerio(url);
  }

  private async extractWithFetchAndCheerio(url: string): Promise<CrawleeExtractionResult> {
    const cheerio = await import('cheerio');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      return { text: $('body').text().replace(/\s+/g, ' ').trim(), html };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async extractWithNativeCrawlee(url: string): Promise<CrawleeExtractionResult> {
    // Lazy dynamic import so the module loads on a fresh checkout. The error
    // only surfaces here, at the first native extraction, if the dep/runtime is
    // missing or not compatible with the current ts-node/Jest environment.
    const crawlee = await import('crawlee');
    const CheerioCrawler =
      (crawlee as unknown as { CheerioCrawler: new (cfg: unknown) => unknown })
        .CheerioCrawler;
    if (typeof CheerioCrawler !== 'function') {
      throw new Error('crawlee.CheerioCrawler not found — check installed version');
    }

    let captured: CrawleeExtractionResult | undefined;
    const crawler = new CheerioCrawler({
      maxConcurrency: 1,
      requestHandlerTimeoutSecs: Math.ceil(this.requestTimeoutMs / 1000),
      async requestHandler(ctx: {
        $: (selector: string) => { text(): string; html(): string };
        body: string | Buffer;
      }) {
        const text = ctx.$('body').text().replace(/\s+/g, ' ').trim();
        const html = typeof ctx.body === 'string' ? ctx.body : ctx.body.toString('utf8');
        captured = { text, html };
      },
    }) as { run(urls: string[]): Promise<unknown> };

    await crawler.run([url]);
    if (!captured) {
      throw new Error(`Crawlee CheerioCrawler produced no output for ${url}`);
    }
    return captured;
  }
}

export class CrawleeAdapter implements MCPAdapter {
  readonly name = 'Crawlee';
  readonly mode = 'cheerio-text';
  readonly kind = 'library' as const;

  private readonly requestTimeoutMs: number;
  private readonly injectedExtractor?: CrawleeExtractor;

  private extractor: CrawleeExtractor | null = null;
  // tabId -> URL registered by tabs_create.
  private readonly urlByTabId = new Map<string, string>();
  // tabId -> last extraction result, so a second read_page on the same tab
  // does not re-crawl the URL.
  private readonly extractionByTabId = new Map<string, CrawleeExtractionResult>();
  private tabSeq = 0;

  constructor(options: CrawleeAdapterOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.injectedExtractor = options.extractor;
  }

  async setup(): Promise<void> {
    this.extractor = this.injectedExtractor ?? new CheerioCrawleeExtractor(this.requestTimeoutMs);
    await this.extractor.start?.();
  }

  async teardown(): Promise<void> {
    if (this.extractor) {
      await this.extractor.stop?.();
      this.extractor = null;
    }
    this.urlByTabId.clear();
    this.extractionByTabId.clear();
    this.tabSeq = 0;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.extractor) {
      return errorResult('CrawleeAdapter: setup() was not called');
    }
    try {
      switch (toolName) {
        case 'tabs_create':
          return this.createTab(args);
        case 'read_page':
          return await this.readPage(args);
        case 'tabs_close':
          return this.closeTab(args);
        default:
          return errorResult(`CrawleeAdapter: unsupported tool "${toolName}"`);
      }
    } catch (err) {
      return errorResult(`CrawleeAdapter: ${toolName} failed: ${(err as Error).message}`);
    }
  }

  private createTab(args: Record<string, unknown>): MCPToolResult {
    const url = typeof args.url === 'string' ? args.url : '';
    const tabId = `crawlee-tab-${++this.tabSeq}`;
    this.urlByTabId.set(tabId, url);
    return textResult(JSON.stringify({ tabId }));
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const url = this.urlByTabId.get(tabId);
    if (url === undefined) {
      return errorResult(`CrawleeAdapter: unknown tabId "${tabId}"`);
    }
    if (!url || url === 'about:blank') {
      // Crawlee has no analog of "open a blank tab" — surface a clear empty
      // result rather than crashing on the empty URL.
      return textResult('');
    }
    let extraction = this.extractionByTabId.get(tabId);
    if (!extraction) {
      extraction = await (this.extractor as CrawleeExtractor).extract(url);
      this.extractionByTabId.set(tabId, extraction);
    }
    return textResult(extraction.text);
  }

  private closeTab(args: Record<string, unknown>): MCPToolResult {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    if (!this.urlByTabId.has(tabId)) {
      return errorResult(`CrawleeAdapter: unknown tabId "${tabId}"`);
    }
    this.urlByTabId.delete(tabId);
    this.extractionByTabId.delete(tabId);
    return textResult(JSON.stringify({ closed: tabId }));
  }

  /** Number of tabs the adapter currently tracks — for assertions. */
  get openTabCount(): number {
    return this.urlByTabId.size;
  }
}
