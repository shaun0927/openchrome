import type * as http from 'node:http';
import { REQUEST_ID_HEADER } from '../../observability/request-id';

export function parseCorsOrigins(raw: string | undefined): Set<string> {
  return new Set((raw || '').split(',').map((origin) => origin.trim()).filter(Boolean));
}

/**
 * Format the configured server bind into a canonical origin host (URL `host`
 * form: `hostname` or `hostname:port`, with IPv6 hostnames bracketed). This
 * value is what `isSameOriginRequest` compares against — it is derived from
 * operator configuration, not from the request, so it cannot be spoofed via
 * the Host header.
 */
export function formatServerOriginHost(host: string, port: number): string {
  const trimmed = host.trim().toLowerCase();
  const stripped = trimmed.replace(/^\[(.*)\]$/, '$1');
  const isIPv6 = stripped.includes(':');
  const hostPart = isIPv6 ? `[${stripped}]` : stripped;
  // Default port 80 is the only http default; OpenChrome binds 3100 by
  // default, but be explicit about what `URL.host` would produce.
  return port === 80 ? hostPart : `${hostPart}:${port}`;
}

/**
 * Treat a request as same-origin when the full origin tuple (scheme, host,
 * port) in the `Origin` header matches the configured server bind. Browsers
 * send `Origin` on same-origin non-GET requests (POST/OPTIONS), so without
 * this bypass a browser app served from the OpenChrome origin would be
 * rejected by the CORS allowlist even though no cross-origin trust boundary
 * is crossed.
 *
 * The comparison uses the operator-configured `host:port`, NOT the client-
 * supplied `Host` header. Trusting the Host header here would let DNS-
 * rebinding attackers (whose page is served from a domain that was rebound
 * to loopback) match `Origin === Host` and bypass the allowlist — defeating
 * the very protection the allowlist provides for the unauthenticated
 * loopback development mode.
 *
 * Scheme is enforced because the HTTP transport speaks plain `http` only;
 * permitting an `https` Origin to bypass the allowlist would let cross-
 * origin `https` callers reach `/mcp` whenever the same host is also exposed
 * over `http`. Operators behind TLS termination must add the public origin
 * to the allowlist explicitly.
 */
function isSameOriginRequest(originValue: string, serverOriginHost: string): boolean {
  try {
    const originUrl = new URL(originValue);
    if (originUrl.protocol !== 'http:') return false;
    return originUrl.host.toLowerCase() === serverOriginHost;
  } catch {
    return false;
  }
}

export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  corsAllowedOrigins: Set<string>,
  serverOriginHost: string,
): boolean {
  const origin = req.headers.origin;
  const originValue = typeof origin === 'string' ? origin : undefined;
  const sameOrigin = originValue ? isSameOriginRequest(originValue, serverOriginHost) : false;
  if (originValue && corsAllowedOrigins.has(originValue)) {
    res.setHeader('Access-Control-Allow-Origin', originValue);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Mcp-Session-Id, Authorization, X-Tenant-Id, ${REQUEST_ID_HEADER}`);
  res.setHeader('Access-Control-Expose-Headers', `Mcp-Session-Id, ${REQUEST_ID_HEADER}`);

  const isMcpEndpoint = pathname === '/mcp' || pathname === '/mcp/sse';
  if (originValue && isMcpEndpoint && !sameOrigin && !corsAllowedOrigins.has(originValue)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'CORS origin not allowed' }));
    return false;
  }
  return true;
}
