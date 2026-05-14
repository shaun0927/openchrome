/**
 * HTTP-based page fetcher for crawl-runner tests (issue #886).
 *
 * Mirrors the signature of `fetchOnePage` from `src/tools/crawl.ts` but
 * uses `http.get` directly instead of a Puppeteer page. This lets the
 * runner be exercised end-to-end against a fixture HTTP server without
 * launching real Chrome.
 */

import * as http from 'node:http';
import type { PageFetcher } from '../../src/core/crawl/runner';

interface FetchedHtml {
  title: string;
  body: string;
  links: string[];
}

function parseHtml(html: string, baseUrl: string): FetchedHtml {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const hrefRe = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        links.push(resolved.toString());
      }
    } catch {
      // skip malformed
    }
  }
  return { title, body, links };
}

export interface SpyState {
  calls: Array<{ url: string; depth: number }>;
  /** Optional hook to throw before the fetch resolves (process-death sim). */
  beforeReturn?: (url: string) => void;
  /** Optional artificial delay between fetches (ms). */
  delayMs?: number;
}

export function makeSpyFetcher(spy: SpyState): PageFetcher {
  return async (sessionId, url, depth, opts) => {
    spy.calls.push({ url, depth });
    const html = await new Promise<string>((resolve, reject) => {
      const req = http.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    if (spy.delayMs && spy.delayMs > 0) {
      await new Promise((r) => setTimeout(r, spy.delayMs));
    }
    if (spy.beforeReturn) {
      spy.beforeReturn(url);
    }
    const parsed = parseHtml(html, url);
    void opts; // outputFormat unused in tests — content is just plain text
    return {
      url,
      title: parsed.title,
      content: parsed.body,
      depth,
      links_found: parsed.links.length,
      _links: parsed.links,
    };
  };
}
