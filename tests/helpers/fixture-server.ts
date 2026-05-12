/**
 * Minimal HTTP fixture server for crawl tests (issue #886).
 *
 * Serves a configurable site graph: each page is named `/<name>` and may
 * link to other pages. Used by the resumable-crawl integration tests to
 * exercise the runner against a real socket without any real Chrome.
 */

import * as http from 'node:http';
import { AddressInfo } from 'node:net';

export interface PageSpec {
  /** Page name — request path will be `/<name>`. */
  name: string;
  /** Names of other pages this page links to. */
  links?: string[];
  /** Page title; defaults to name. */
  title?: string;
  /** Inline body content; defaults to a single <p>. */
  body?: string;
}

export interface FixtureServer {
  port: number;
  url(name?: string): string;
  close(): Promise<void>;
}

/**
 * Start a fixture HTTP server. The promise resolves once the server is
 * listening; callers should `await close()` in teardown to release the port.
 */
export async function startFixtureServer(pages: PageSpec[]): Promise<FixtureServer> {
  const byName = new Map<string, PageSpec>();
  for (const p of pages) byName.set(p.name, p);

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').replace(/\?.*$/, '');
    const name = urlPath === '/' ? pages[0]?.name : urlPath.slice(1);
    const spec = name ? byName.get(name) : undefined;
    if (!spec) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body>not found</body></html>');
      return;
    }
    const title = spec.title ?? spec.name;
    const body = spec.body ?? `<p>page ${spec.name}</p>`;
    const links = (spec.links ?? [])
      .map((l) => `<a href="/${l}">link to ${l}</a>`)
      .join('\n');
    const html = `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}\n${links}</body></html>`;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url(name?: string): string {
      return `http://127.0.0.1:${port}/${name ?? pages[0].name}`;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
