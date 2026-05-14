/**
 * Puppeteer competitor adapter for the competitive benchmark suite (#1255).
 *
 * Drives Puppeteer through the same `callTool(toolName, args)` surface the
 * OpenChrome MCP adapters expose, so a benchmark task (e.g. measureLatency in
 * tests/benchmark/latency.ts) runs against Puppeteer with byte-identical task
 * code — the only variable is the library (Epic #1254, methodology #4).
 *
 * Puppeteer is not an MCP server; this adapter translates the small set of
 * benchmark tool calls into Puppeteer operations:
 *   tabs_create({ url })  -> newPage() + page.goto(url)  -> { tabId }
 *   read_page({ tabId })  -> page.content()              -> raw HTML
 *   tabs_close({ tabId }) -> page.close()
 *
 * `puppeteer-core` is already a project dependency; this adapter connects to
 * an already-running Chrome over CDP (no bundled-browser download). The CDP
 * `connect` is injected via a factory so the translation logic is unit-
 * testable against a mock browser, with the real connection exercised behind
 * an env-gated integration check.
 */

import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

/** Minimal Puppeteer Page surface this adapter uses. */
export interface PuppeteerPageLike {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

/** Minimal Puppeteer Browser surface this adapter uses. */
export interface PuppeteerBrowserLike {
  newPage(): Promise<PuppeteerPageLike>;
  disconnect(): Promise<void>;
}

export interface PuppeteerAdapterOptions {
  /** CDP endpoint of an already-running Chrome, e.g. http://127.0.0.1:9222. */
  browserURL?: string;
  /**
   * Connect factory — defaults to puppeteer-core's connect(). Injected so the
   * translation logic can be unit-tested against a mock browser.
   */
  connect?: (browserURL: string) => Promise<PuppeteerBrowserLike>;
}

const DEFAULT_BROWSER_URL = 'http://127.0.0.1:9222';

async function defaultConnect(browserURL: string): Promise<PuppeteerBrowserLike> {
  // Lazy import: keeps the module loadable (and unit-testable with a mock
  // connect) on machines without a reachable Chrome.
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.connect({ browserURL });
  return browser as unknown as PuppeteerBrowserLike;
}

function textResult(text: string): MCPToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): MCPToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export class PuppeteerAdapter implements MCPAdapter {
  readonly name = 'Puppeteer';
  readonly mode = 'raw-html';
  readonly kind = 'library' as const;

  private readonly browserURL: string;
  private readonly connect: (browserURL: string) => Promise<PuppeteerBrowserLike>;
  private browser: PuppeteerBrowserLike | null = null;
  private readonly pages = new Map<string, PuppeteerPageLike>();
  private tabSeq = 0;

  constructor(options: PuppeteerAdapterOptions = {}) {
    this.browserURL = options.browserURL ?? DEFAULT_BROWSER_URL;
    this.connect = options.connect ?? defaultConnect;
  }

  async setup(): Promise<void> {
    this.browser = await this.connect(this.browserURL);
  }

  async teardown(): Promise<void> {
    for (const page of this.pages.values()) {
      await page.close().catch(() => undefined);
    }
    this.pages.clear();
    if (this.browser) {
      await this.browser.disconnect().catch(() => undefined);
      this.browser = null;
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (!this.browser) {
      return errorResult('PuppeteerAdapter: setup() was not called');
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
          return errorResult(`PuppeteerAdapter: unsupported tool "${toolName}"`);
      }
    } catch (err) {
      return errorResult(`PuppeteerAdapter: ${toolName} failed: ${(err as Error).message}`);
    }
  }

  private async createTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const page = await (this.browser as PuppeteerBrowserLike).newPage();
    const url = typeof args.url === 'string' ? args.url : undefined;
    if (url && url !== 'about:blank') {
      await page.goto(url);
    }
    const tabId = `puppeteer-tab-${++this.tabSeq}`;
    this.pages.set(tabId, page);
    return textResult(JSON.stringify({ tabId }));
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const page = this.pages.get(tabId);
    if (!page) {
      return errorResult(`PuppeteerAdapter: unknown tabId "${tabId}"`);
    }
    // Puppeteer's idiomatic "give this to an LLM" surface is the raw HTML;
    // the Token Efficiency axis (#1256) compares that against OpenChrome's
    // compact DOM, so this adapter returns it unembellished.
    return textResult(await page.content());
  }

  private async closeTab(args: Record<string, unknown>): Promise<MCPToolResult> {
    const tabId = typeof args.tabId === 'string' ? args.tabId : '';
    const page = this.pages.get(tabId);
    if (!page) {
      return errorResult(`PuppeteerAdapter: unknown tabId "${tabId}"`);
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
