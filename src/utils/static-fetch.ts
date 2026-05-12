/**
 * static-fetch — Node built-in fetch wrapper for the crawl/crawl_sitemap fast-path.
 *
 * Provides:
 *   - staticFetch(url, opts): perform an HTTP GET with manual redirect handling,
 *     UA injection, size cap and AbortSignal-based timeout.
 *   - isStaticSufficient(html, status, contentType): deterministic check used to
 *     decide whether the static response is good enough or the crawler must fall
 *     back to the CDP tab path.
 *   - getBodyText(html): regex-based extractor used when A1's extractMainContent
 *     is not yet available in the tree.
 *
 * Zero new dependencies (Node 20+ built-in fetch / undici).
 *
 * @see https://github.com/shaun0927/openchrome/issues/885
 */

import { readFileSync } from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MIN_BODY_BYTES = 256;
const MIN_BODY_TEXT_CHARS = 200;
const MAX_REDIRECTS = 5;

const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

const SPA_PLACEHOLDER_IDS = ['root', '__next', 'app'];

// ---------------------------------------------------------------------------
// User-Agent resolution
// ---------------------------------------------------------------------------

let cachedDefaultUA: string | null = null;

function resolveDefaultUserAgent(): string {
  if (cachedDefaultUA) return cachedDefaultUA;
  let version = '0.0.0';
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // ignore — fall back to placeholder version
  }
  cachedDefaultUA = `OpenChrome-Static/${version}`;
  return cachedDefaultUA;
}

export function getStaticUserAgent(): string {
  return process.env.OC_STATIC_USER_AGENT || resolveDefaultUserAgent();
}

function getTimeoutMs(): number {
  const raw = process.env.OC_STATIC_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function getMaxBytes(): number {
  const raw = process.env.OC_STATIC_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StaticFetchResult {
  html: string;
  status: number;
  contentType: string;
  finalUrl: string;
}

export interface StaticFetchOptions {
  /** Per-request timeout in milliseconds (default: OC_STATIC_TIMEOUT_MS / 10000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default: OC_STATIC_MAX_BYTES / 5 MB). */
  maxBytes?: number;
  /** User-Agent override (default: OC_STATIC_USER_AGENT). */
  userAgent?: string;
  /** External AbortSignal merged with the timeout signal. */
  signal?: AbortSignal;
}

export type StaticReason =
  | 'ok'
  | 'non-2xx'
  | 'non-html'
  | 'too-small'
  | 'too-large'
  | 'spa-placeholder'
  | 'noscript-required'
  | 'fetch-error';

export interface SufficiencyResult {
  ok: boolean;
  reason: StaticReason;
}

// ---------------------------------------------------------------------------
// staticFetch
// ---------------------------------------------------------------------------

export class StaticFetchError extends Error {
  readonly reason: StaticReason;
  constructor(message: string, reason: StaticReason = 'fetch-error') {
    super(message);
    this.name = 'StaticFetchError';
    this.reason = reason;
  }
}

export async function staticFetch(
  url: string,
  opts: StaticFetchOptions = {},
): Promise<StaticFetchResult> {
  const timeoutMs = opts.timeoutMs ?? getTimeoutMs();
  const maxBytes = opts.maxBytes ?? getMaxBytes();
  const userAgent = opts.userAgent ?? getStaticUserAgent();

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('static-fetch timeout')), timeoutMs);

  // Chain external signal: abort our controller when caller aborts.
  let onExternalAbort: (() => void) | null = null;
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      onExternalAbort = () => controller.abort(opts.signal!.reason);
      opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });

      // Manual redirect handling: 3xx with Location header → re-issue.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          if (hop >= MAX_REDIRECTS) {
            throw new StaticFetchError(`too many redirects (> ${MAX_REDIRECTS})`);
          }
          // Drain body to release the socket.
          try {
            await response.arrayBuffer();
          } catch {
            // ignore drain errors
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
      }

      const contentType = response.headers.get('content-type') || '';

      // Early reject if Content-Length declares oversized payload.
      const declaredLen = response.headers.get('content-length');
      if (declaredLen) {
        const n = Number(declaredLen);
        if (Number.isFinite(n) && n > maxBytes) {
          try {
            await response.arrayBuffer();
          } catch {
            // ignore drain errors
          }
          throw new StaticFetchError(
            `response too large: ${n} > ${maxBytes}`,
            'too-large',
          );
        }
      }

      const html = await readBodyWithCap(response, maxBytes);

      return {
        html,
        status: response.status,
        contentType,
        finalUrl: currentUrl,
      };
    }
    throw new StaticFetchError(`too many redirects (> ${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timeoutHandle);
    if (opts.signal && onExternalAbort) {
      opts.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return await response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new StaticFetchError(
          `response too large: streamed > ${maxBytes}`,
          'too-large',
        );
      }
      chunks.push(value);
    }
  }
  const total = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    total.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(total);
}

// ---------------------------------------------------------------------------
// Body-text extraction
// ---------------------------------------------------------------------------

interface ExtractMainContentFn {
  (html: string, opts?: { onlyMainContent?: boolean }): string;
}

let cachedExtractMainContent: ExtractMainContentFn | null | undefined;

function tryLoadA1Extractor(): ExtractMainContentFn | null {
  if (cachedExtractMainContent !== undefined) return cachedExtractMainContent;
  try {
    // Resolve at runtime so A3 doesn't hard-depend on A1.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../core/extract/html-to-markdown');
    if (mod && typeof mod.extractMainContent === 'function') {
      cachedExtractMainContent = mod.extractMainContent as ExtractMainContentFn;
      return cachedExtractMainContent;
    }
  } catch {
    // not present yet — fall through
  }
  cachedExtractMainContent = null;
  return null;
}

/**
 * Regex-based body-text extractor used when A1's extractMainContent isn't
 * available. Strips <script>, <style>, all tags and collapses whitespace.
 *
 * Exported separately so it can be unit-tested independently of the dynamic
 * resolution in extractBodyText().
 */
export function getBodyText(html: string): string {
  if (!html) return '';
  // Restrict to <body> when present.
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  let body = bodyMatch ? bodyMatch[1] : html;
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  body = body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ');
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body.replace(/&nbsp;/gi, ' ');
  body = body.replace(/&amp;/gi, '&');
  body = body.replace(/&lt;/gi, '<');
  body = body.replace(/&gt;/gi, '>');
  body = body.replace(/&quot;/gi, '"');
  body = body.replace(/&#39;/gi, "'");
  body = body.replace(/\s+/g, ' ').trim();
  return body;
}

/**
 * Extract body text using A1's extractor when present, otherwise the regex
 * fallback. Behavior is observable through the StaticBodyTextSource return.
 */
export function extractBodyText(html: string): { text: string; source: 'a1' | 'fallback' } {
  const a1 = tryLoadA1Extractor();
  if (a1) {
    try {
      const out = a1(html, { onlyMainContent: false });
      if (typeof out === 'string') return { text: out, source: 'a1' };
    } catch {
      // fall through to regex extractor
    }
  }
  return { text: getBodyText(html), source: 'fallback' };
}

/** Test-only: reset the cached extractor so tests can exercise both branches. */
export function __resetExtractorCacheForTests(): void {
  cachedExtractMainContent = undefined;
}

// ---------------------------------------------------------------------------
// isStaticSufficient
// ---------------------------------------------------------------------------

/**
 * Deterministic sufficiency check. A static response is sufficient iff all
 * six checks pass. Order matters: earlier reasons short-circuit.
 */
export function isStaticSufficient(
  html: string,
  status: number,
  contentType: string,
): SufficiencyResult {
  // 1. 2xx status
  if (status < 200 || status >= 300) {
    return { ok: false, reason: 'non-2xx' };
  }

  // 2. Content-Type
  const ctLower = (contentType || '').toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.some((prefix) => ctLower.startsWith(prefix))) {
    return { ok: false, reason: 'non-html' };
  }

  // 3. Size envelope (raw HTML byte length proxy via string length is fine
  //    for this heuristic; UTF-8 chars >= 1 byte).
  const size = Buffer.byteLength(html, 'utf8');
  if (size < MIN_BODY_BYTES) {
    return { ok: false, reason: 'too-small' };
  }
  if (size > getMaxBytes()) {
    return { ok: false, reason: 'too-large' };
  }

  // 5. JS-required <noscript>. Check before SPA placeholder so the more
  //    specific reason wins.
  if (hasNoscriptJsRequired(html)) {
    return { ok: false, reason: 'noscript-required' };
  }

  // 6. SPA placeholder shell.
  if (isSpaPlaceholder(html)) {
    return { ok: false, reason: 'spa-placeholder' };
  }

  // 4. Body text length.
  const { text } = extractBodyText(html);
  if (text.length < MIN_BODY_TEXT_CHARS) {
    return { ok: false, reason: 'too-small' };
  }

  return { ok: true, reason: 'ok' };
}

function hasNoscriptJsRequired(html: string): boolean {
  const re = /<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (/enable JavaScript|requires JavaScript/i.test(m[1])) {
      return true;
    }
  }
  return false;
}

function isSpaPlaceholder(html: string): boolean {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (!bodyMatch) return false;
  const body = bodyMatch[1];

  // Strip comments, scripts, styles — these don't count as "element children".
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');

  // Find a single root container <div id="root|__next|app" ... > ... </div>
  // with no nested elements (text/whitespace only).
  const containerRe = /^\s*<div\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/div\s*>\s*$/i;
  const match = stripped.match(containerRe);
  if (!match) return false;
  const id = match[1];
  if (!SPA_PLACEHOLDER_IDS.includes(id)) return false;
  const inner = match[2];
  // No child elements (allow text / whitespace).
  return !/<[a-zA-Z]/.test(inner);
}
