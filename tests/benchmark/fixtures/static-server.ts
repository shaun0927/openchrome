/**
 * Local static fixture server for the competitive benchmark suite.
 *
 * Latency and throughput measurements (#1258) must have zero network variance
 * and byte-identical input across every library, so they run against this
 * local server rather than live sites. Each route serves a deterministically
 * generated HTML page of a controlled DOM weight — no timestamps, no random,
 * so a given weight is byte-identical on every request and every run.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';

export type PageWeight = 'small' | 'medium' | 'large';

export const PAGE_WEIGHTS: readonly PageWeight[] = ['small', 'medium', 'large'];

/**
 * The throughput axis (#1258) uses a 50-page mirror — same byte-identical
 * server, distinct page indices so HTTP caching and DOM keys do not collapse
 * the workload to a single response. Each page is a small fixture (~25 nodes)
 * so the measurement is concurrency-bound, not parse-bound.
 */
export const THROUGHPUT_PAGE_COUNT = 50;

/** Number of repeated content nodes per weight tier. */
const WEIGHT_NODE_COUNT: Record<PageWeight, number> = {
  small: 25,
  medium: 500,
  large: 5000,
};

/**
 * Deterministically generate a fixture HTML page of the given weight.
 * Byte-identical for a given weight on every call.
 */
export function generateFixtureHtml(weight: PageWeight): string {
  const count = WEIGHT_NODE_COUNT[weight];
  const rows: string[] = [];
  for (let i = 0; i < count; i++) {
    rows.push(
      `<article class="item" data-index="${i}">` +
        `<h2>Item ${i}</h2>` +
        `<p>Deterministic body text for benchmark item ${i}. ` +
        `Stable content so latency and throughput have no input variance.</p>` +
        `<a href="/item/${i}">link ${i}</a>` +
        '</article>',
    );
  }
  return (
    '<!doctype html><html lang="en"><head>' +
    `<meta charset="utf-8"><title>Benchmark fixture - ${weight}</title>` +
    '</head><body>' +
    `<header><h1>Benchmark fixture: ${weight}</h1></header>` +
    `<main>${rows.join('')}</main>` +
    '<footer><p>openchrome benchmark static fixture</p></footer>' +
    '</body></html>'
  );
}

function isPageWeight(value: string): value is PageWeight {
  return (PAGE_WEIGHTS as readonly string[]).includes(value);
}

/**
 * Deterministic per-page HTML for the throughput mirror. Page bodies vary
 * by `index` so HTTP caches and DOM identity caches cannot collapse all 50
 * pages into one response — but every page is small (~25 nodes) so the
 * measurement is dominated by concurrency / wall-clock cost, not parse cost.
 */
export function generateThroughputPageHtml(index: number): string {
  const rows: string[] = [];
  for (let i = 0; i < 25; i++) {
    rows.push(
      `<article class="item" data-page="${index}" data-index="${i}">` +
        `<h2>Page ${index} · Item ${i}</h2>` +
        `<p>Deterministic body text for page ${index} item ${i}.</p>` +
        `<a href="/page/${index}/item/${i}">link ${i}</a>` +
        '</article>',
    );
  }
  return (
    '<!doctype html><html lang="en"><head>' +
    `<meta charset="utf-8"><title>Throughput mirror page ${index}</title>` +
    '</head><body>' +
    `<header><h1>Throughput fixture page ${index}</h1></header>` +
    `<main>${rows.join('')}</main>` +
    '<footer><p>openchrome benchmark throughput mirror</p></footer>' +
    '</body></html>'
  );
}

const PAGE_PATH_RE = /^page\/(\d+)$/;

export interface StaticFixtureServer {
  /** Port the server is listening on (ephemeral). */
  readonly port: number;
  /** Absolute URL for a given page weight (latency mode). */
  url(weight: PageWeight): string;
  /** Absolute URL for one of the throughput mirror pages (`/page/N`). */
  pageUrl(index: number): string;
  /** All `THROUGHPUT_PAGE_COUNT` mirror URLs in index order. */
  pageUrls(): string[];
  /** Stop the server. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Start the local static fixture server on an ephemeral loopback port. The
 * caller owns the lifecycle and must call `close()` when done.
 */
export async function startStaticFixtureServer(): Promise<StaticFixtureServer> {
  // Pre-generate each body once — every request for a weight returns the
  // identical bytes, so the server adds no per-request variance.
  const bodies = new Map<PageWeight, string>();
  for (const weight of PAGE_WEIGHTS) {
    bodies.set(weight, generateFixtureHtml(weight));
  }
  // Same idea for the throughput mirror: pre-generate the 50 distinct pages
  // so per-request work is just send-bytes, not generate-bytes.
  const pageBodies = new Map<number, string>();
  for (let i = 0; i < THROUGHPUT_PAGE_COUNT; i++) {
    pageBodies.set(i, generateThroughputPageHtml(i));
  }

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').replace(/^\/+/, '').split('?')[0];
    if (isPageWeight(pathname)) {
      const body = bodies.get(pathname) as string;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    const pageMatch = PAGE_PATH_RE.exec(pathname);
    if (pageMatch) {
      const idx = Number(pageMatch[1]);
      const body = pageBodies.get(idx);
      if (body) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not a benchmark fixture route');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  let closed = false;

  return {
    port,
    url(weight: PageWeight): string {
      return `http://127.0.0.1:${port}/${weight}`;
    },
    pageUrl(index: number): string {
      return `http://127.0.0.1:${port}/page/${index}`;
    },
    pageUrls(): string[] {
      const urls: string[] = [];
      for (let i = 0; i < THROUGHPUT_PAGE_COUNT; i++) {
        urls.push(`http://127.0.0.1:${port}/page/${i}`);
      }
      return urls;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
