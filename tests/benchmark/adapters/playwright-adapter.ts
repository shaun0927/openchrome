/**
 * Playwright competitor adapter for the competitive benchmark suite (#1255).
 *
 * Drives Playwright through the same `callTool(toolName, args)` surface the
 * OpenChrome MCP adapters expose, so a benchmark task runs against Playwright
 * with byte-identical task code — the only variable is the library (Epic
 * #1254, methodology #4).
 *
 * Playwright is not an MCP server; this adapter translates the benchmark tool
 * calls into Playwright operations:
 *   tabs_create({ url })  -> context.newPage() + page.goto(url) -> { tabId }
 *   read_page({ tabId })  -> page.content()                     -> raw HTML
 *   tabs_close({ tabId }) -> page.close()
 *
 * The adapter connects to an already-running Chrome over CDP
 * (`chromium.connectOverCDP`), so Playwright's bundled browsers are NOT
 * required — the `playwright` package is a devDependency for its API + types
 * only. The connect call is injected via a factory so the translation logic
 * is unit-testable against a mock browser.
 */

import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

/** Minimal Playwright Page surface this adapter uses. */
export interface PlaywrightPageLike {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

/** Minimal Playwright BrowserContext surface this adapter uses. */
export interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>;
}

/** Minimal Playwright Browser surface this adapter uses. */
export interface PlaywrightBrowserLike {
  contexts(): PlaywrightContextLike[];
  newContext(): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightAdapterOptions {
  /** CDP endpoint of an already-running Chrome, e.g. http://127.0.0.1:9222. */
  cdpEndpoint?: string;
  /**
   * Connect factory — defaults to playwright's chromium.connectOverCDP().
   * Injected so the translation logic can be unit-tested against a mock.
   */
  connect?: (cdpEndpoint: string) => Promise<PlaywrightBrowserLike>;
}

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';

async function defaultConnect(cdpEndpoint: string): Promise<PlaywrightBrowserLike> {
  // Lazy import: keeps the module loadable (and unit-testable with a mock
  // connect) on machines without a reachable Chrome.
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  return browser as unknown as PlaywrightBrowserLike;
}

function textResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export class PlaywrightAdapter implements MCPAdapter {
  readonly name = 'Playwright';
  readonly mode = 'raw-html';
  readonly kind = 'library' as const;

  private readonly cdpEndpoint: string;
  private readonly connect: (cdpEndpoint: string) => Promise<PlaywrightBrowserLike>;
  private browser: PlaywrightBrowserLike | null = null;
  private context: PlaywrightContextLike | null = null;
  private readonly pages = new Map<string, PlaywrightPageLike>();
  private tabSeq = 0;

  constructor(options: PlaywrightAdapterOptions = {}) {
    this.cdpEndpoint = options.cdpEndpoint ?? DEFAULT_CDP_ENDPOINT;
    this.connect = options.connect ?? defaultConnect;
  }

  async setup(): Promise<void> {
    this.browser = await this.connect(this.cdpEndpoint);
    // connectOverCDP exposes the existing browser's default context; reuse it
    // so the adapter shares auth state with the running Chrome, matching how
    // benchmark/parallel-isolated.mjs operates.
    const existing = this.browser.contexts();
    this.context = existing.length > 0 ? existing[0] : await this.browser.newContext();
  }

  async teardown(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch(() => undefined);
    }
    this.pages.clear();
    this.context = null;
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.context) {
      return errorResult('PlaywrightAdapter: setup() was not called');
    }
    try {
      switch (toolName) {
        case 'tabs_create':
          return await this.createTab(args);
        case 'read_page':
          return await this.readPage(args);
        case 'tabs_close':
          return await this.closeTab(args);
        default:
          return errorResult(`PlaywrightAdapter: unsupported tool "${toolName}"`);
      }
    } catch (err) {
      return errorResult(`PlaywrightAdapter: ${toolName} failed: ${(err as Error).message}`);
    }
  }

  private async createTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const page = await (this.context as PlaywrightContextLike).newPage();
    const url = typeof args.url === 'string' ? args.url : undefined;
    if (url && url !== 'about:blank') {
      await page.goto(url);
    }
    const tabId = `playwright-tab-${++this.tabSeq}`;
    this.pages.set(tabId, page);
    return textResult(JSON.stringify({ tabId }));
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const page = this.pages.get(tabId);
    if (!page) {
      return errorResult(`PlaywrightAdapter: unknown tabId "${tabId}"`);
    }
    // Playwright's idiomatic "give this to an LLM" surface is the raw HTML;
    // the Token Efficiency axis (#1256) compares that against OpenChrome's
    // compact DOM, so this adapter returns it unembellished.
    return textResult(await page.content());
  }

  private async closeTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const page = this.pages.get(tabId);
    if (!page) {
      return errorResult(`PlaywrightAdapter: unknown tabId "${tabId}"`);
    }
    await page.close();
    this.pages.delete(tabId);
    return textResult(JSON.stringify({ closed: tabId }));
  }

  /** Number of pages this adapter currently tracks — for assertions. */
  get openTabCount(): number {
    return this.pages.size;
  }
}
