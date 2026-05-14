/**
 * Library-agnostic fault-injection proxy for the Reliability axis (#1259).
 *
 * Sits between a benchmarked library and an upstream HTTP server and injects
 * faults at the HTTP layer. Two properties this guarantees, both required by
 * the #1259 design:
 *   - library-agnostic: faults are injected at the transport, never via any
 *     library's internals, so every library faces the identical fault.
 *   - deterministic: faults are armed/cleared via setFault(), so injection
 *     happens at an exact, chosen point in a flow.
 *
 * The CDP-level injectors (tab crash, CDP-connection drop) are a separate
 * work unit — they cannot be done at the HTTP layer.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';

/**
 * A fault to inject into proxied responses.
 *  - none:          forward normally.
 *  - network-drop:  destroy the socket with no response (simulates a dropped
 *                   connection / unreachable upstream).
 *  - latency:       wait `delayMs` before forwarding the real response.
 *  - http-error:    respond with `status` and a short body, never reaching
 *                   the upstream.
 *  - body-mutation: forward the real response but rewrite the body, replacing
 *                   every occurrence of `find` with `replace` (used to e.g.
 *                   strip an element and simulate a stale selector).
 */
export type FaultSpec =
  | { kind: 'none' }
  | { kind: 'network-drop' }
  | { kind: 'latency'; delayMs: number }
  | { kind: 'http-error'; status: number }
  | { kind: 'body-mutation'; find: string; replace: string };

export interface FaultInjectionProxy {
  readonly port: number;
  readonly url: string;
  /** Arm a fault for subsequent requests; { kind: 'none' } clears it. */
  setFault(fault: FaultSpec): void;
  /** The currently armed fault. */
  getFault(): FaultSpec;
  /** Number of requests handled since start (across all fault states). */
  readonly requestCount: number;
  close(): Promise<void>;
}

export interface StartProxyOptions {
  /** Upstream origin to forward to, e.g. "http://127.0.0.1:54321". */
  upstreamBaseUrl: string;
  /** Fault armed at start. Defaults to { kind: 'none' }. */
  initialFault?: FaultSpec;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hop-by-hop and framing headers that must NOT be copied verbatim from the
 * upstream response onto the proxy response — the proxy sets its own framing
 * (content-length), and passing through e.g. `transfer-encoding: chunked`
 * alongside a `content-length` is a protocol conflict that breaks the client.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

function sanitizeUpstreamHeaders(
  upstreamHeaders: http.IncomingHttpHeaders,
  body: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  // The proxy owns framing — body length may differ from upstream after a
  // body-mutation fault.
  headers['content-length'] = String(Buffer.byteLength(body));
  return headers;
}

function validateFault(fault: FaultSpec): void {
  if (fault.kind === 'latency' && (!Number.isFinite(fault.delayMs) || fault.delayMs < 0)) {
    throw new Error(`latency fault delayMs must be a non-negative number, got ${fault.delayMs}`);
  }
  if (fault.kind === 'http-error' && (!Number.isInteger(fault.status) || fault.status < 400)) {
    throw new Error(`http-error fault status must be an integer >= 400, got ${fault.status}`);
  }
}

/**
 * Forward one request to the upstream and resolve with the full response
 * (status, headers, body as a string).
 */
function forward(
  upstream: URL,
  req: http.IncomingMessage,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const upstreamReq = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        headers: { ...req.headers, host: upstream.host },
      },
      (upstreamRes) => {
        let body = '';
        upstreamRes.setEncoding('utf8');
        upstreamRes.on('data', (chunk) => (body += chunk));
        upstreamRes.on('end', () =>
          resolve({ status: upstreamRes.statusCode ?? 502, headers: upstreamRes.headers, body }),
        );
      },
    );
    upstreamReq.on('error', reject);
    req.pipe(upstreamReq);
  });
}

/**
 * Start the fault-injection proxy on an ephemeral loopback port. The caller
 * owns the lifecycle and must call `close()`.
 */
export async function startFaultInjectionProxy(
  options: StartProxyOptions,
): Promise<FaultInjectionProxy> {
  const upstream = new URL(options.upstreamBaseUrl);
  let fault: FaultSpec = options.initialFault ?? { kind: 'none' };
  validateFault(fault);
  let requestCount = 0;

  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    const active = fault;

    if (active.kind === 'network-drop') {
      req.socket.destroy();
      return;
    }

    if (active.kind === 'http-error') {
      res.writeHead(active.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`fault-injection: forced HTTP ${active.status}`);
      return;
    }

    try {
      if (active.kind === 'latency') {
        await delay(active.delayMs);
      }
      const upstreamRes = await forward(upstream, req);
      let body = upstreamRes.body;
      if (active.kind === 'body-mutation') {
        body = body.split(active.find).join(active.replace);
      }
      res.writeHead(upstreamRes.status, sanitizeUpstreamHeaders(upstreamRes.headers, body));
      res.end(body);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`fault-injection proxy: upstream error: ${(err as Error).message}`);
    }
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
    setFault(next: FaultSpec): void {
      validateFault(next);
      fault = next;
    },
    getFault(): FaultSpec {
      return fault;
    },
    get requestCount(): number {
      return requestCount;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
