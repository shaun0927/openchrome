/**
 * CDP Host Guard — non-localhost refuse gate for `browserWSEndpoint` / DevTools HTTP.
 *
 * Why this exists
 * ---------------
 * openchrome's `CDPClient` accepts any `browserWSEndpoint` and forwards it to
 * `puppeteer.connect()`. A misconfigured launcher, hostile CLI flag, or a
 * malicious MCP client can point the endpoint at a **remote** host and turn
 * the local operator's session into a proxy for someone else's Chrome —
 * cookies, storage state, and CDP command surface are all handed over.
 *
 * The Chrome team is explicit that `--remote-debugging-port` binds only to
 * localhost by design, and remote debugging is considered a security bug when
 * the socket leaks off-box. openchrome should refuse to connect to a
 * non-loopback endpoint by default, and require an explicit `--allow-remote`
 * opt-in for the (rare) supervised remote-debugging bridge case.
 *
 * Design
 * ------
 *   1. `parseEndpoint(url)` — normalises ws/wss/http/https URL to `{ hostname,
 *      port, protocol }`. Rejects malformed input up front.
 *   2. `isLoopbackHost(hostname)` — decides "loopback" using a fixed allowlist
 *      (`localhost`, `127.0.0.1`, `[::1]`, `::1`) plus RFC1122 127/8. Any
 *      other host — including link-local, private LAN (10/8, 172.16/12,
 *      192.168/16), Tailscale (100.64/10), and public IPs — is non-loopback.
 *   3. `assertHostAllowed(url, opts)` — throws `RemoteHostRefusedError` if the
 *      endpoint is non-loopback and `opts.allowRemote !== true`. When allow
 *      is set, emits a one-shot `console.error` audit line so operators can
 *      see they are running in the opt-in mode.
 *   4. `RemoteHostRefusedError` — typed error with `{ hostname, protocol,
 *      code: 'remote_host_refused' }` so MCP callers can surface a structured
 *      error rather than a raw `puppeteer.connect()` failure.
 *
 * Environment override
 * --------------------
 * `OPENCHROME_ALLOW_REMOTE_CDP=1` grants the opt-in without a CLI flag, for
 * environments where the CLI entry point is out of the caller's control (e.g.
 * a wrapped MCP shim). The opt-in is still surfaced in the audit line.
 *
 * Origin credit
 * -------------
 * The "loopback-only unless opted in" idiom is the same guard the Chrome
 * DevTools team documents for `--remote-debugging-port`. This module is a
 * clean-room implementation; no upstream Chrome/DevTools code is copied.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface HostGuardOptions {
  /** When true, non-loopback endpoints are allowed (audit line still emitted). */
  allowRemote?: boolean;
  /** Optional logger override — defaults to `console.error`. */
  logger?: (msg: string) => void;
}

export interface ParsedEndpoint {
  hostname: string;
  port: string;
  protocol: string;
  href: string;
}

export class RemoteHostRefusedError extends Error {
  readonly code = 'remote_host_refused' as const;
  readonly hostname: string;
  readonly protocol: string;
  readonly endpoint: string;

  constructor(endpoint: ParsedEndpoint) {
    super(
      `CDP host guard refused non-localhost endpoint ` +
        `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}. ` +
        `Pass --allow-remote (or set OPENCHROME_ALLOW_REMOTE_CDP=1) to opt in.`,
    );
    this.name = 'RemoteHostRefusedError';
    this.hostname = endpoint.hostname;
    this.protocol = endpoint.protocol;
    this.endpoint = endpoint.href;
  }
}

/**
 * Parse a CDP endpoint URL into structured parts. Throws on malformed input.
 *
 * Accepts ws/wss/http/https. Bracketed IPv6 (`[::1]`) is unwrapped so the
 * loopback check sees the raw form.
 */
export function parseEndpoint(url: string): ParsedEndpoint {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('parseEndpoint: url must be a non-empty string');
  }
  const parsed = new URL(url);
  let hostname = parsed.hostname;
  // WHATWG URL keeps IPv6 hostnames bare (no brackets) — normalise just in case
  // a caller passes a pre-bracketed form via manual string manipulation.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return {
    hostname,
    port: parsed.port,
    protocol: parsed.protocol,
    href: parsed.href,
  };
}

/**
 * Return true iff hostname is loopback (localhost, 127/8, ::1).
 *
 * Private LAN, link-local, Tailscale, and public IPs all return false.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8 — the full IPv4 loopback range, not just 127.0.0.1.
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) {
    return h.split('.').every((octet) => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return false;
}

/**
 * Read the environment opt-in flag. Kept as a module-level function so
 * tests can stub `process.env` before each call.
 */
export function envAllowRemote(): boolean {
  const raw = process.env.OPENCHROME_ALLOW_REMOTE_CDP;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

let auditEmitted = false;

/** Reset the one-shot audit latch — test-only. */
export function resetHostGuardAuditLatch(): void {
  auditEmitted = false;
}

/**
 * Refuse the connection unless the endpoint is loopback or the caller opted in.
 *
 * When the caller opts in (either via `opts.allowRemote` or the env flag),
 * emit a single audit line so operators know they are running unlocked.
 */
export function assertHostAllowed(url: string, opts: HostGuardOptions = {}): ParsedEndpoint {
  const endpoint = parseEndpoint(url);
  if (isLoopbackHost(endpoint.hostname)) return endpoint;

  const allow = opts.allowRemote === true || envAllowRemote();
  if (!allow) {
    throw new RemoteHostRefusedError(endpoint);
  }

  if (!auditEmitted) {
    auditEmitted = true;
    const log = opts.logger ?? ((msg: string) => console.error(msg));
    log(
      `[CDPClient] --allow-remote is ACTIVE. Connecting to non-loopback CDP endpoint ` +
        `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}. ` +
        `Cookies and storage state on the remote Chrome will be exposed to this client.`,
    );
  }
  return endpoint;
}

/**
 * Convenience predicate — true when the endpoint would be refused under
 * default policy (no allowRemote, no env opt-in). Useful for pre-flight
 * checks that want to surface the reason without throwing.
 */
export function wouldRefuse(url: string): boolean {
  try {
    const endpoint = parseEndpoint(url);
    return !isLoopbackHost(endpoint.hostname);
  } catch {
    // Malformed URLs are refused at parse time by assertHostAllowed.
    return true;
  }
}
