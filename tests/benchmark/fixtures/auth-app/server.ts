/**
 * Local login-wall app for the Auth & Real-World Usability axis (#1260).
 *
 * The reproducible tier of the auth benchmark: a self-hosted app with a real
 * login wall and a seeded test account. Running auth scenarios against this —
 * rather than live third-party sites — keeps #1260 reproducible and avoids any
 * ToS concern. The live tier (real sites, operator's own accounts) is a
 * separate, clearly-labeled, best-effort work unit.
 *
 * Routes:
 *   GET  /login      -> login form
 *   POST /login      -> validate credentials, set a session cookie, redirect /
 *   GET  /           -> protected dashboard when authenticated, else 302 /login
 *   GET  /logout     -> clear the session, redirect /login
 *
 * No credentials are committed beyond the throwaway seeded test account below;
 * it only ever exists in-process.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';

/** The seeded throwaway test account — in-process only, never persisted. */
export const AUTH_APP_CREDENTIALS = {
  username: 'bench-user',
  password: 'bench-pass-2026',
} as const;

const SESSION_COOKIE = 'oc_bench_sid';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const LOGIN_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Benchmark Login</title></head><body>' +
  '<h1>Sign in</h1>' +
  '<form method="POST" action="/login">' +
  '<label>Username <input name="username" type="text"></label>' +
  '<label>Password <input name="password" type="password"></label>' +
  '<button type="submit">Sign in</button>' +
  '</form></body></html>';

function dashboardPage(username: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>Benchmark Dashboard</title></head><body>' +
    `<h1>Welcome, ${username}</h1>` +
    '<p data-testid="protected-content">This content is only visible when authenticated.</p>' +
    '<a href="/logout">Log out</a>' +
    '</body></html>'
  );
}

export interface AuthApp {
  readonly port: number;
  readonly url: string;
  readonly credentials: typeof AUTH_APP_CREDENTIALS;
  /** Number of currently active sessions — useful for assertions. */
  readonly activeSessions: number;
  close(): Promise<void>;
}

/**
 * Start the login-wall app on an ephemeral loopback port. The caller owns the
 * lifecycle and must call `close()`.
 */
export async function startAuthApp(): Promise<AuthApp> {
  // session id -> username
  const sessions = new Map<string, string>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cookies = parseCookies(req.headers.cookie);
    const sessionUser = cookies[SESSION_COOKIE]
      ? sessions.get(cookies[SESSION_COOKIE])
      : undefined;

    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const username = form.get('username') ?? '';
      const password = form.get('password') ?? '';
      if (
        username === AUTH_APP_CREDENTIALS.username &&
        password === AUTH_APP_CREDENTIALS.password
      ) {
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.set(sid, username);
        res.writeHead(302, {
          'set-cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; Max-Age=86400`,
          location: '/',
        });
        res.end();
      } else {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><h1>Invalid credentials</h1></body></html>');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/logout') {
      if (cookies[SESSION_COOKIE]) sessions.delete(cookies[SESSION_COOKIE]);
      res.writeHead(302, {
        'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
        location: '/login',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      if (!sessionUser) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardPage(sessionUser));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  let closed = false;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    credentials: AUTH_APP_CREDENTIALS,
    get activeSessions(): number {
      return sessions.size;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      // Browser drivers keep HTTP/1.1 sockets alive; force-close them so the
      // benchmark runner can terminate promptly after each measured run.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
