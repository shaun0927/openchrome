/// <reference types="jest" />

import * as http from 'http';
import { startAuthApp, AuthApp, AUTH_APP_CREDENTIALS } from './server';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Minimal HTTP client that does NOT follow redirects, so tests can assert
 *  on the 302s the login wall returns. */
function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers['set-cookie']?.[0] ?? '';
  return setCookie.split(';')[0];
}

describe('auth-app login-wall fixture', () => {
  let app: AuthApp;

  beforeAll(async () => {
    app = await startAuthApp();
  });

  afterAll(async () => {
    await app.close();
  });

  test('the dashboard is gated — unauthenticated GET / redirects to /login', async () => {
    const res = await request(app.url + '/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /login serves the login form', async () => {
    const res = await request(app.url + '/login');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<form method="POST" action="/login">');
  });

  test('wrong credentials are rejected with 401', async () => {
    const res = await request(app.url + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=bench-user&password=wrong',
    });
    expect(res.status).toBe(401);
    expect(app.activeSessions).toBe(0);
  });

  test('correct credentials set a session cookie and unlock the dashboard', async () => {
    const login = await request(app.url + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=${AUTH_APP_CREDENTIALS.username}&password=${AUTH_APP_CREDENTIALS.password}`,
    });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/');
    const cookie = sessionCookie(login);
    expect(cookie).toContain('oc_bench_sid=');

    const dashboard = await request(app.url + '/', { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toContain('data-testid="protected-content"');
    expect(dashboard.body).toContain(AUTH_APP_CREDENTIALS.username);
  });

  test('logout clears the session and re-locks the dashboard', async () => {
    const login = await request(app.url + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=${AUTH_APP_CREDENTIALS.username}&password=${AUTH_APP_CREDENTIALS.password}`,
    });
    const cookie = sessionCookie(login);

    await request(app.url + '/logout', { headers: { cookie } });
    const afterLogout = await request(app.url + '/', { headers: { cookie } });
    expect(afterLogout.status).toBe(302);
    expect(afterLogout.headers.location).toBe('/login');
  });

  test('a forged / unknown session cookie does not unlock the dashboard', async () => {
    const res = await request(app.url + '/', {
      headers: { cookie: 'oc_bench_sid=not-a-real-session' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});
