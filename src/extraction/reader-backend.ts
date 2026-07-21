/**
 * Reader backend contract — pluggable URL→markdown converters.
 *
 * Why this exists
 * ---------------
 * Multiple upstream projects independently converged on the same
 * shape for "give me a URL, get back clean markdown":
 *
 *  - jina reader — header-controlled HTTP endpoint that returns
 *    markdown (`X-Return-Format: markdown`), no JS execution client-
 *    side. Fast, cheap, sometimes wrong on JS-heavy pages.
 *  - trafilatura — Python library that wins content-extraction
 *    benchmarks by a wide margin. Requires HTML input; produces main-
 *    content markdown after boilerplate removal.
 *  - crawl4ai — DOM-aware markdown generator with fit-markdown scoring
 *    on top (see `./fit-markdown.ts`).
 *
 * The differences are real (JS execution, cost, licensing) but the
 * caller wants a uniform interface: "extract markdown from this URL
 * or from this HTML, tell me which backend produced it, and let me
 * swap without touching call sites."
 *
 * Design
 * ------
 * `ReaderBackend` is the sanctioned interface. Two runtime shapes:
 *
 *  1. `ReaderBackend.fromUrl(url, opts)` — for network backends
 *     (jina reader, remote APIs). Backend owns fetch + conversion.
 *  2. `ReaderBackend.fromHtml(html, opts)` — for local backends
 *     (trafilatura shell adapter, crawl4ai binding, in-process
 *     converter). Caller has already fetched the HTML.
 *
 * Each backend can implement either or both. The registry lets
 * callers list what's installed and pick by name or capability.
 *
 * Adapters (not shipped inline)
 * -----------------------------
 * A concrete adapter is a *tiny* file that wraps the external tool
 * and calls `registerReaderBackend()` at import time. Adapters live
 * in `src/extraction/adapters/<name>.ts` and are opt-in — the core
 * module has no runtime dependency on any specific tool.
 *
 * Origin credit
 * -------------
 * Adapter shape converges the jina reader HTTP contract, the
 * trafilatura Python API, and crawl4ai's AsyncWebCrawler.arun.
 * Clean-room definition; no upstream code copied.
 */

export interface ReaderInput {
  /** Original URL (always required for provenance). */
  url: string;
  /** Pre-fetched HTML — supplied only for fromHtml() calls. */
  html?: string;
  /** Optional query hint the backend may use to tune extraction. */
  query?: string;
  /** Optional per-call timeout (ms). */
  timeoutMs?: number;
  /** Optional caller-provided fetch (for testability / custom transport). */
  fetch?: typeof fetch;
}

export interface ReaderResult {
  /** Cleaned markdown. */
  markdown: string;
  /** Backend that produced this result. */
  backend: string;
  /** URL the backend actually resolved (may differ after redirects). */
  resolvedUrl: string;
  /** Bytes of input the backend saw (network body or html length). */
  inputBytes: number;
  /** Extraction wall-clock time (ms). */
  elapsedMs: number;
  /** Optional per-backend metadata (title, author, publish-date...). */
  meta?: Readonly<Record<string, unknown>>;
}

export type BackendCapability = 'url' | 'html';

export interface ReaderBackend {
  readonly name: string;
  readonly capabilities: readonly BackendCapability[];
  fromUrl?(input: ReaderInput): Promise<ReaderResult>;
  fromHtml?(input: ReaderInput & { html: string }): Promise<ReaderResult>;
}

const _registry = new Map<string, ReaderBackend>();

/** Register a backend. Overwrite semantics — last registration wins. */
export function registerReaderBackend(backend: ReaderBackend): void {
  if (!backend || typeof backend.name !== 'string' || backend.name.length === 0) {
    throw new TypeError('registerReaderBackend: backend.name is required');
  }
  const caps = backend.capabilities ?? [];
  if (caps.length === 0) {
    throw new TypeError(`registerReaderBackend(${backend.name}): capabilities must be non-empty`);
  }
  if (caps.includes('url') && typeof backend.fromUrl !== 'function') {
    throw new TypeError(`registerReaderBackend(${backend.name}): capability 'url' requires fromUrl()`);
  }
  if (caps.includes('html') && typeof backend.fromHtml !== 'function') {
    throw new TypeError(`registerReaderBackend(${backend.name}): capability 'html' requires fromHtml()`);
  }
  _registry.set(backend.name, backend);
}

/** Look up a backend by name. Returns undefined if not registered. */
export function getReaderBackend(name: string): ReaderBackend | undefined {
  return _registry.get(name);
}

/** List all registered backends. */
export function listReaderBackends(): ReaderBackend[] {
  return [..._registry.values()];
}

/** Pick the first backend that supports a capability. */
export function pickBackendFor(capability: BackendCapability): ReaderBackend | undefined {
  for (const backend of _registry.values()) {
    if (backend.capabilities.includes(capability)) return backend;
  }
  return undefined;
}

/** Test-only registry reset. */
export function resetReaderBackendsForTests(): void {
  _registry.clear();
}
