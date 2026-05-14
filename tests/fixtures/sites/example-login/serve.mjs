#!/usr/bin/env node
/**
 * Minimal hermetic fixture site for the dynamic-skills replay test.
 *
 * Serves three routes:
 *   GET  /          — login form (username + password inputs, submit button)
 *   POST /login     — accepts demo/demo, redirects to /home, otherwise /
 *   GET  /home      — "logged-in" page with `.logged-in` marker
 *
 * Usage:
 *   node tests/fixtures/sites/example-login/serve.mjs [port]
 *
 * Default port: 0 (OS picks). The chosen port is printed to stdout as JSON
 * `{"port": <n>}` on the first line so test harnesses can capture it.
 */

import { createServer } from 'node:http';
import { URLSearchParams } from 'node:url';

const port = parseInt(process.argv[2] ?? '0', 10);

const LOGIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>example login</title></head>
<body>
  <h1>Sign in</h1>
  <form id="login" method="POST" action="/login">
    <label>Username <input id="username" name="username" type="text" autocomplete="username" /></label>
    <label>Password <input id="password" name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">Sign in</button>
  </form>
</body></html>`;

const HOME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>welcome</title></head>
<body>
  <h1>Welcome</h1>
  <p class="logged-in" data-test="logged-in">You are logged in.</p>
</body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/login') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const ok = params.get('username') === 'demo' && params.get('password') === 'demo';
    res.writeHead(303, { location: ok ? '/home' : '/' });
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/home') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HOME_HTML);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  process.stdout.write(JSON.stringify({ port: actual }) + '\n');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
