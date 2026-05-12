/**
 * DevTools info fetcher — queries Chrome's /json/list and /json/version endpoints.
 * Uses the same http.request pattern as src/chrome/pool.ts#checkDebugPort.
 */

import * as http from 'http';

export interface ChromePageInfo {
  id: string;
  url: string;
  title: string;
  devtoolsFrontendUrl: string;
  webSocketDebuggerUrl: string;
  type: string;
}

export interface DevToolsInstanceInfo {
  instancePort: number;
  browserInspectorUrl: string;
  pages: Array<{
    targetId: string;
    instancePort: number;
    url: string;
    title: string;
    devtoolsFrontendUrl: string;
  }>;
}

/**
 * Fetch /json/list from a Chrome debug port.
 * Returns null when the port is unreachable or returns malformed JSON.
 */
export async function fetchJsonList(port: number): Promise<ChromePageInfo[] | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/list',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed)) {
              resolve(null);
              return;
            }
            resolve(parsed as ChromePageInfo[]);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Fetch /json/version to get the browser-level WebSocket URL.
 * Returns null on failure.
 */
export async function fetchJsonVersion(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/version',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // e.g. { "webSocketDebuggerUrl": "ws://127.0.0.1:9222/json/version" }
            resolve(typeof parsed?.webSocketDebuggerUrl === 'string' ? parsed.webSocketDebuggerUrl : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Build a browser inspector URL from a Chrome debug port.
 * Chrome's /json/version returns `webSocketDebuggerUrl` like:
 *   ws://127.0.0.1:9222/json/version
 * The HTTP DevTools inspector equivalent is:
 *   http://127.0.0.1:9222/devtools/browser/<id>
 *
 * Falls back to constructing a deterministic URL from /json/version data.
 * Returns a placeholder string on failure (so callers can still build partial info).
 */
export async function getBrowserInspectorUrl(port: number): Promise<string> {
  const wsUrl = await fetchJsonVersion(port);
  if (wsUrl) {
    // ws://127.0.0.1:9222/json/version  ->  http://127.0.0.1:9222/devtools/browser/<uuid>
    // Some Chrome builds give: ws://127.0.0.1:9222/devtools/browser/<uuid>
    const devtoolsBrowserMatch = wsUrl.match(/devtools\/browser\/([0-9a-f-]+)/i);
    if (devtoolsBrowserMatch) {
      return `http://127.0.0.1:${port}/devtools/browser/${devtoolsBrowserMatch[1]}`;
    }
  }
  // Fallback: canonical-form URL; still useful as a human-readable hint
  return `http://127.0.0.1:${port}/devtools/browser/`;
}

/**
 * Query a single Chrome instance and return its DevToolsInstanceInfo.
 * Returns null if the instance is unreachable.
 */
export async function getDevToolsInstanceInfo(port: number): Promise<DevToolsInstanceInfo | null> {
  const [pages, browserInspectorUrl] = await Promise.all([
    fetchJsonList(port),
    getBrowserInspectorUrl(port),
  ]);

  if (pages === null) {
    return null;
  }

  return {
    instancePort: port,
    browserInspectorUrl,
    pages: pages.map((p) => ({
      targetId: p.id,
      instancePort: port,
      url: p.url,
      title: p.title,
      devtoolsFrontendUrl: p.devtoolsFrontendUrl,
    })),
  };
}
