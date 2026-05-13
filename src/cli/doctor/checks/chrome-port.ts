/**
 * Check: chrome-port
 * Verifies port 9222 is either free or hosts a valid CDP endpoint.
 */

import * as net from 'net';
import type { CheckFn } from '../../doctor';

const DEFAULT_CDP_PORT = 9222;

function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function probeCdpEndpoint(port: number): Promise<{ ok: boolean; browser?: string; error?: string }> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json() as Record<string, string>;
    return { ok: true, browser: data['Browser'] ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function getHoldingPid(port: number): string | null {
  try {
    const { execSync } = require('child_process');
    const platform = process.platform;
    let out: string;
    if (platform === 'win32') {
      out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 3000 });
      const match = out.match(/\s+(\d+)\s*$/m);
      return match ? match[1] : null;
    } else if (platform === 'darwin') {
      out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', timeout: 3000 });
      return out.trim().split('\n')[0] ?? null;
    } else {
      out = execSync(`ss -tlpn 'sport = :${port}'`, { encoding: 'utf8', timeout: 3000 });
      const match = out.match(/pid=(\d+)/);
      return match ? match[1] : null;
    }
  } catch {
    return null;
  }
}

export const checkChromePort: CheckFn = async () => {
  const port = parseInt(process.env.CHROME_PORT ?? String(DEFAULT_CDP_PORT), 10);
  const free = await isPortFree(port);

  if (free) {
    return {
      id: 'chrome-port',
      title: `CDP port ${port}`,
      status: 'ok',
      detail: `Port ${port} is free`,
    };
  }

  // Port is in use — check if it's a valid CDP endpoint
  const cdp = await probeCdpEndpoint(port);
  if (cdp.ok) {
    return {
      id: 'chrome-port',
      title: `CDP port ${port}`,
      status: 'ok',
      detail: `CDP endpoint active: ${cdp.browser}`,
    };
  }

  // Port busy but not a CDP endpoint — warn (not fail; another process may be valid)
  const pid = getHoldingPid(port);
  const pidInfo = pid ? ` (held by PID ${pid})` : '';
  return {
    id: 'chrome-port',
    title: `CDP port ${port}`,
    status: 'warn',
    detail: `Port ${port} is in use${pidInfo} but no CDP endpoint found`,
    remediation: `Free port ${port} or set CHROME_PORT to a different port`,
  };
};
