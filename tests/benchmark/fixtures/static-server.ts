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

export interface StaticFixtureServer {
  /** Port the server is listening on (ephemeral). */
  readonly port: number;
  /** Absolute URL for a given page weight. */
  url(weight: PageWeight): string;
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
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
