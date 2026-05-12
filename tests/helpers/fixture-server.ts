/**
 * fixture-server — minimal HTTP test fixture used by static-fetch and crawl
 * engine integration tests. No external dependencies, no caching, no global
 * state. Each test should start its own instance and close it in afterAll.
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

export interface FixtureServer {
  url: string;
  origin: string;
  server: http.Server;
  close(): Promise<void>;
  setRoute(path: string, route: FixtureRoute): void;
  removeRoute(path: string): void;
  hitCount(path: string): number;
}

export async function startFixtureServer(
  initialRoutes: Record<string, FixtureRoute> = {},
): Promise<FixtureServer> {
  const routes = new Map<string, FixtureRoute>(Object.entries(initialRoutes));
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
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    url: origin,
    origin,
    server,
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
