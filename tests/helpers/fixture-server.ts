/**
 * fixture-server — minimal HTTP test fixture used by static-fetch, crawl, and
 * resumable crawl integration tests. No external dependencies, no caching, no
 * global state. Each test should start its own instance and close it.
 */

import * as http from 'http';
import { AddressInfo } from 'net';

export interface FixtureRoute {
  status?: number;
  contentType?: string;
  /** Body to write (string or buffer). Ignored when handler is provided. */
  body?: string | Buffer;
  /** Header overrides; takes precedence over status/contentType/body. */
  headers?: Record<string, string>;
  /** Delay before responding, in milliseconds. */
  delayMs?: number;
  /** Full custom handler (overrides all other fields). */
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
}

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
  /** Origin URL, e.g. http://127.0.0.1:<port>. */
  origin: string;
  /** Convenience graph URL builder for PageSpec fixtures. */
  url(name?: string): string;
  server: http.Server;
  port: number;
  close(): Promise<void>;
  setRoute(path: string, route: FixtureRoute): void;
  removeRoute(path: string): void;
  hitCount(path: string): number;
}

function routesFromPageSpecs(pages: PageSpec[]): Record<string, FixtureRoute> {
  const routes: Record<string, FixtureRoute> = {};
  const firstName = pages[0]?.name;
  for (const spec of pages) {
    const title = spec.title ?? spec.name;
    const body = spec.body ?? `<p>page ${spec.name}</p>`;
    const links = (spec.links ?? [])
      .map((l) => `<a href="/${l}">link to ${l}</a>`)
      .join('\n');
    routes[`/${spec.name}`] = {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}\n${links}</body></html>`,
    };
  }
  if (firstName && !routes['/']) {
    routes['/'] = routes[`/${firstName}`];
  }
  return routes;
}

export async function startFixtureServer(
  initialRoutes: Record<string, FixtureRoute> | PageSpec[] = {},
): Promise<FixtureServer> {
  const pageSpecs = Array.isArray(initialRoutes) ? initialRoutes : null;
  const routes = new Map<string, FixtureRoute>(
    Object.entries(pageSpecs ? routesFromPageSpecs(pageSpecs) : initialRoutes),
  );
  const hits = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const reqUrl = req.url ?? '/';
    const pathOnly = reqUrl.split('?')[0];
    hits.set(pathOnly, (hits.get(pathOnly) ?? 0) + 1);

    const route = routes.get(pathOnly);
    if (!route) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('not found');
      return;
    }

    if (route.delayMs) {
      await new Promise((r) => setTimeout(r, route.delayMs));
    }

    if (route.handler) {
      await route.handler(req, res);
      return;
    }

    const status = route.status ?? 200;
    res.statusCode = status;
    const contentType = route.contentType ?? 'text/html; charset=utf-8';
    res.setHeader('content-type', contentType);
    if (route.headers) {
      for (const [k, v] of Object.entries(route.headers)) {
        res.setHeader(k, v);
      }
    }
    const body = route.body ?? '';
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    server,
    port,
    url(name?: string) {
      if (!pageSpecs) return origin;
      return `${origin}/${name ?? pageSpecs[0].name}`;
    },
    setRoute(path: string, route: FixtureRoute) {
      routes.set(path, route);
    },
    removeRoute(path: string) {
      routes.delete(path);
    },
    hitCount(path: string) {
      return hits.get(path) ?? 0;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
