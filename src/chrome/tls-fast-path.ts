/**
 * TLS / JA3 fast-path fetch adapter.
 *
 * Motivation
 * ----------
 * A large fraction of "browser automation" work is really "download this
 * HTML/JSON". Spinning up a real Chrome, attaching CDP, waiting on
 * navigation, and tearing down again costs seconds of wall clock and
 * several MB of RAM per call — for a request that a plain `fetch` could
 * finish in milliseconds. openchrome already knows this: it has
 * `headed-fallback.ts` for the reverse direction (fetch failed, escalate
 * to Chrome). What is missing is the *forward* path: attempt a fetch
 * first with a browser-shaped TLS handshake, only escalating to Chrome
 * when the target actually challenges us.
 *
 * The trouble with plain Node `fetch` is its TLS fingerprint (JA3) does
 * not look like a real Chrome. Cloudflare, DataDome, and Akamai all
 * fingerprint that handshake and can block on the very first byte
 * without so much as sending an HTML challenge. So a naive fast-path
 * *always* looks like a bot and *always* fails, which is why nobody
 * builds it in Node.
 *
 * The escape hatch, popularised by curl_cffi and hrequests, is to
 * delegate the TLS handshake to a separately-installed
 * `curl-impersonate` binary — a curl fork that speaks Chrome's exact JA3
 * — and read the response body over stdout. If the binary is absent,
 * this module falls back to native fetch and marks the response as
 * "generic TLS", so the caller can decide whether the risk is
 * acceptable.
 *
 * This module is deliberately a small policy-plus-shell wrapper. It does
 * not link native code, does not depend on any npm package, and holds no
 * state across calls. All actual TLS is done by the external binary.
 *
 * Contract
 * --------
 *   const adapter = createTlsFastPathAdapter();
 *   const result = await adapter.fetch({ url, headers });
 *   if (result.kind === 'ok') { ... }
 *   else if (result.kind === 'challenge') escalateToChrome();
 *   else if (result.kind === 'unavailable') fallbackToPlainFetch();
 *
 * Clean-room. Idea attribution (see census entries A2 curl_cffi and A6
 * hrequests). No code copied from either project.
 */

import { spawn } from 'node:child_process';

export type TlsFastPathKind = 'ok' | 'challenge' | 'unavailable' | 'error';

export interface TlsFastPathRequest {
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Readonly<Record<string, string>>;
  /** How long to wait for the binary to respond, in ms. Default 15_000. */
  timeoutMs?: number;
  /**
   * Which browser profile to impersonate. Corresponds to a curl-impersonate
   * build target, e.g. `chrome124`, `chrome116`, `firefox117`. Default
   * `chrome124`.
   */
  impersonate?: string;
}

export interface TlsFastPathResponse {
  kind: TlsFastPathKind;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  reason?: string;
}

export interface TlsFastPathAdapterOptions {
  /** Absolute path to a curl-impersonate binary. Auto-detected if omitted. */
  binaryPath?: string;
  /** If true, do not attempt native fetch fallback. Default false. */
  disableFallback?: boolean;
  /**
   * Injected spawner, for tests. Must resemble node's `spawn` signature.
   */
  spawnImpl?: typeof spawn;
  /**
   * Injected native fetch, for tests. Must resemble `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
}

export interface TlsFastPathAdapter {
  fetch(request: TlsFastPathRequest): Promise<TlsFastPathResponse>;
  readonly binaryPath: string | undefined;
}

/**
 * Domains and status-code combinations that generally indicate a
 * bot-check challenge rather than a real response. When these fire the
 * caller should escalate to a real Chrome session.
 */
const CHALLENGE_STATUS = new Set([403, 429, 503]);
const CHALLENGE_BODY_HINTS = [
  'cf-mitigated',
  'challenge-platform',
  'window._cf_chl_opt',
  'datadome',
  'Distil',
  'Please enable JavaScript and cookies',
];

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_IMPERSONATE = 'chrome124';

export function createTlsFastPathAdapter(
  options: TlsFastPathAdapterOptions = {},
): TlsFastPathAdapter {
  const binaryPath = options.binaryPath ?? autoDetectBinary();
  const spawner = options.spawnImpl ?? spawn;
  const nativeFetch = options.fetchImpl ?? globalThis.fetch;
  const disableFallback = options.disableFallback === true;

  return {
    binaryPath,
    async fetch(request) {
      if (binaryPath) {
        try {
          return await runCurlImpersonate(binaryPath, request, spawner);
        } catch (error) {
          if (disableFallback) {
            return { kind: 'error', reason: describeError(error) };
          }
          // Fall through to native fetch fallback.
        }
      }
      if (disableFallback) {
        return { kind: 'unavailable', reason: 'binary-missing' };
      }
      return runNativeFetch(request, nativeFetch);
    },
  };
}

function autoDetectBinary(): string | undefined {
  const envPath = process.env.OPENCHROME_TLS_FAST_PATH;
  if (envPath && envPath.length > 0) return envPath;
  // No filesystem probe — we defer that to the caller. Returning undefined
  // here keeps the module free of blocking IO at import time.
  return undefined;
}

function runCurlImpersonate(
  binary: string,
  request: TlsFastPathRequest,
  spawner: typeof spawn,
): Promise<TlsFastPathResponse> {
  return new Promise((resolve) => {
    const args = ['-sS', '-i', '--max-time',
      String(Math.ceil((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))];
    if (request.method === 'HEAD') args.push('-I');
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      args.push('-H', `${name}: ${value}`);
    }
    // curl-impersonate exposes profile selection via alias binaries, not
    // via a flag. If the caller passed a bare binary name we let them
    // manage the alias; if they passed a directory we resolve it here.
    const targetBinary = resolveImpersonateBinary(binary, request.impersonate);
    args.push(request.url);

    const child = spawner(targetBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ kind: 'error', reason: 'timeout' });
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ kind: 'error', reason: describeError(error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ kind: 'error', reason: stderr.trim() || `exit=${code}` });
        return;
      }
      resolve(interpretCurlResponse(stdout));
    });
  });
}

function resolveImpersonateBinary(binary: string, impersonate?: string): string {
  const profile = impersonate ?? DEFAULT_IMPERSONATE;
  if (binary.endsWith('/curl-impersonate') || binary.endsWith('\\curl-impersonate')) {
    // Directory-style install: curl-impersonate-<profile>
    return `${binary}-${profile}`;
  }
  // Assume the caller pinned a specific binary; ignore profile.
  return binary;
}

async function runNativeFetch(
  request: TlsFastPathRequest,
  fetchImpl: typeof fetch,
): Promise<TlsFastPathResponse> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    const response = await fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers as Record<string, string> | undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const body = request.method === 'HEAD' ? '' : await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return classify({
      status: response.status,
      headers,
      body,
      contentType: response.headers.get('content-type') ?? undefined,
      reason: 'native-fetch',
    });
  } catch (error) {
    return { kind: 'error', reason: describeError(error) };
  }
}

/**
 * Parse `curl -i` output — status line + headers + blank line + body.
 * Extremely small, purpose-built parser; do not use elsewhere.
 */
export function interpretCurlResponse(raw: string): TlsFastPathResponse {
  const separator = raw.indexOf('\r\n\r\n');
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator + 4);
  const lines = headerBlock.split(/\r\n/);
  const statusLine = lines.shift() ?? '';
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return classify({
    status,
    headers,
    body,
    contentType: headers['content-type'],
    reason: 'curl-impersonate',
  });
}

function classify(input: {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType?: string;
  reason: string;
}): TlsFastPathResponse {
  if (CHALLENGE_STATUS.has(input.status)) {
    return { kind: 'challenge', ...input };
  }
  const lowered = input.body.slice(0, 4096).toLowerCase();
  if (CHALLENGE_BODY_HINTS.some((hint) => lowered.includes(hint.toLowerCase()))) {
    return { kind: 'challenge', ...input };
  }
  if (input.status >= 200 && input.status < 400) {
    return { kind: 'ok', ...input };
  }
  return { kind: 'error', ...input };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
