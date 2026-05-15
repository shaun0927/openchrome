/**
 * Benchmark Adapters barrel file
 * Re-exports all adapter implementations for convenient import.
 */

// Stub adapter (for CI / deterministic testing)
export {
  OpenChromeStubAdapter,
  OpenChromeAdapter, // backward compat alias
  OpenChromeAdapterOptions,
} from './openchrome-adapter';

// Real adapter (for actual performance benchmarking)
export {
  OpenChromeRealAdapter,
  RealAdapterOptions,
} from './openchrome-real-adapter';

// Competitor adapters — same callTool surface, different library underneath.
export {
  PuppeteerAdapter,
  PuppeteerAdapterOptions,
  PuppeteerBrowserLike,
  PuppeteerPageLike,
} from './puppeteer-adapter';

export {
  PlaywrightAdapter,
  PlaywrightAdapterOptions,
  PlaywrightBrowserLike,
  PlaywrightContextLike,
  PlaywrightPageLike,
} from './playwright-adapter';

export {
  PlaywrightMcpAdapter,
  PlaywrightMcpAdapterOptions,
  PlaywrightMcpTransport,
} from './playwright-mcp-adapter';

export {
  CrawleeAdapter,
  CrawleeAdapterOptions,
  CrawleeExtractor,
  CrawleeExtractionResult,
} from './crawlee-adapter';

export {
  BrowserUseAdapter,
  BrowserUseAdapterOptions,
  BrowserUseBridgeTransport,
  BridgeResponse,
} from './browser-use-adapter';
