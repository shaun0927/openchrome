/**
 * E2E Global Setup — launches MCP server + fixture HTTP server.
 * Runs once before all E2E tests.
 */
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';

// Fixture pages for E2E scenarios
const FIXTURE_PAGES: Record<string, string> = {
  '/': mainPage(),
  '/site-a': sitePage('Site A', 'Welcome to Site A', '<button id="submit">Submit</button>'),
  '/site-b': sitePage('Site B', 'Search Portal', '<form id="search"><input type="text" name="q" /><button type="submit">Search</button></form>'),
  '/site-c': sitePage('Site C', 'Data Dashboard', '<table class="data"><tr><td>Row 1</td></tr><tr><td>Row 2</td></tr></table>'),
  '/login': loginPage(),
  '/protected': protectedPage(),
  '/slow': slowPage(),
};

function mainPage(): string {
  return `<!DOCTYPE html><html><head><title>E2E Test Main</title></head>
<body><h1>OpenChrome E2E Test</h1><p>Main test page</p></body></html>`;
}

function sitePage(title: string, heading: string, content: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
<body><h1>${heading}</h1>${content}</body></html>`;
}

function loginPage(): string {
  return `<!DOCTYPE html><html><head><title>Login</title></head>
<body>
  <h1>Login</h1>
  <form id="login-form" method="POST" action="/login">
    <input type="text" name="username" id="username" />
    <input type="password" name="password" id="password" />
    <button type="submit" id="login-btn">Login</button>
  </form>
  <script>
    document.getElementById('login-form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.cookie = "session_id=e2e_test_session_abc123; path=/; max-age=86400";
      document.cookie = "user=testuser; path=/; max-age=86400";
      window.location.href = '/protected';
    });
  </script>
</body></html>`;
}

function protectedPage(): string {
  return `<!DOCTYPE html><html><head><title>Protected</title></head>
<body><h1>Protected Page</h1><p>You are logged in.</p>
<script>
  if (!document.cookie.includes('session_id')) {
    document.body.innerHTML = '<h1>Access Denied</h1><p>Please login first.</p>';
  }
</script>
</body></html>`;
}

function slowPage(): string {
  return `<!DOCTYPE html><html><head><title>Slow Page</title></head>
<body><h1>Slow Loading Page</h1><p>This page loaded after a delay.</p></body></html>`;
}

let fixtureServer: http.Server;

export default async function globalSetup(): Promise<void> {
  // Each scenario owns its MCP process. Global setup only owns the shared,
  // deterministic fixture server so no unused controller competes on port 9222.
  const PORT = 18924;
  fixtureServer = http.createServer((req, res) => {
    const url = req.url?.split('?')[0] || '/';

    // Handle slow endpoint with delay
    if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(FIXTURE_PAGES['/slow']);
      }, 3000);
      return;
    }

    // Handle login POST (set cookie via response header)
    if (url === '/login' && req.method === 'POST') {
      res.writeHead(302, {
        'Set-Cookie': 'session_id=e2e_test_session_abc123; Path=/; Max-Age=86400',
        'Location': '/protected',
      });
      res.end();
      return;
    }

    const html = FIXTURE_PAGES[url];
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(PORT, () => {
      fixtureServer.off('error', reject);
      console.error(`[e2e-setup] Fixture server on http://localhost:${PORT}`);
      resolve();
    });
  });

  // Store references for tests and teardown.
  (globalThis as Record<string, unknown>).__E2E_FIXTURE_PORT__ = PORT;
  (globalThis as Record<string, unknown>).__E2E_FIXTURE_SERVER__ = fixtureServer;

  // Also write port to a temp file so test files can read it
  const stateFile = path.join(process.cwd(), '.e2e-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ port: PORT }));

  console.error('[e2e-setup] Fixture server ready; scenarios will launch isolated MCP processes');
}
