/**
 * Fixture HTTP Server for E2E tests.
 * Serves static test pages + dynamic endpoints (login, slow response, etc.)
 */
import * as http from 'http';

export interface FixtureServerOptions {
  port?: number;
}

export class FixtureServer {
  private server: http.Server | null = null;
  private port: number;
  private customRoutes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();

  constructor(opts?: FixtureServerOptions) {
    this.port = opts?.port ?? 18924;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = req.url?.split('?')[0] || '/';

        // Check custom routes first
        const customHandler = this.customRoutes.get(url);
        if (customHandler) {
          customHandler(req, res);
          return;
        }

        // Default routes
        this.handleDefaultRoute(url, req, res);
      });

      this.server.on('error', reject);
      this.server.listen(this.port, () => {
        console.error(`[fixture-server] Listening on http://localhost:${this.port}`);
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Add a custom route handler.
   */
  addRoute(path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.customRoutes.set(path, handler);
  }

  getUrl(path: string = '/'): string {
    return `http://localhost:${this.port}${path}`;
  }

  private handleDefaultRoute(url: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const pages: Record<string, string> = {
      '/': this.mainPage(),
      '/site-a': this.sitePage('Site A', 'Welcome to Site A', '<button id="submit">Submit</button><p>Content for site A</p>'),
      '/site-b': this.sitePage('Site B', 'Search Portal', '<form id="search"><input type="text" name="q" placeholder="Search..."/><button type="submit">Search</button></form>'),
      '/site-c': this.sitePage('Site C', 'Data Dashboard', '<table class="data"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Row 1</td><td>100</td></tr><tr><td>Row 2</td><td>200</td></tr></tbody></table>'),
      '/login': this.loginPage(),
      '/protected': this.protectedPage(),
    };

    // Slow endpoint
    if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Slow Page</h1></body></html>');
      }, 3000);
      return;
    }

    // Login POST
    if (url === '/login' && req.method === 'POST') {
      res.writeHead(302, {
        'Set-Cookie': 'session_id=e2e_test_session_abc123; Path=/; Max-Age=86400',
        'Location': '/protected',
      });
      res.end();
      return;
    }

    const html = pages[url];
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  private mainPage(): string {
    return `<!DOCTYPE html><html><head><title>E2E Test Main</title></head>
<body><h1>OpenChrome E2E Test</h1><p>Main test page for E2E scenarios.</p>
<div id="dynamic-content"><p id="counter">Count: 0</p></div></body></html>`;
  }

  private sitePage(title: string, heading: string, content: string): string {
    return `<!DOCTYPE html><html><head><title>${title}</title></head>
<body><h1>${heading}</h1>${content}</body></html>`;
  }

  private loginPage(): string {
    return `<!DOCTYPE html><html><head><title>Login</title></head>
<body><h1>Login</h1>
<form id="login-form"><input type="text" name="username" id="username"/>
<input type="password" name="password" id="password"/>
<button type="submit" id="login-btn">Login</button></form>
<script>document.getElementById('login-form').addEventListener('submit',function(e){
e.preventDefault();document.cookie="session_id=e2e_test_session_abc123;path=/;max-age=86400";
document.cookie="user=testuser;path=/;max-age=86400";window.location.href='/protected';});</script>
</body></html>`;
  }

  private protectedPage(): string {
    return `<!DOCTYPE html><html><head><title>Protected</title></head>
<body><h1>Protected Page</h1><p>You are logged in.</p>
<script>if(!document.cookie.includes('session_id')){document.body.innerHTML='<h1>Access Denied</h1>';}</script>
</body></html>`;
  }
}
