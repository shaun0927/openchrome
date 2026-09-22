import * as readline from 'readline';
import type { BrokerMetadata } from '../broker/discovery';
import { readBrokerMetadata } from '../broker/discovery';
import { MCPErrorCodes, MCPResponse } from '../types/mcp';
import { isPidAlive } from '../chrome/controller-lock';

/**
 * Exit code a re-electing client uses when it detects its broker owner has died.
 * The MCP host respawns the stdio server, which re-runs the controller-lock
 * election (#1480 S2/S3) and — with the old owner gone — typically wins and
 * becomes the new owner, removing the single-point-of-failure (#1480 S4).
 */
export const BROKER_REELECT_EXIT_CODE = 75;

const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';
export const BROKER_CLIENT_ID_HEADER = 'X-OpenChrome-Broker-Client-Id';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/** Methods whose Streamable HTTP request must carry an `Mcp-Name` header. */
const MCP_NAME_SOURCE: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

/**
 * The protocol version a 2026-07-28-style request names in its per-request
 * envelope, or undefined for legacy (initialize-based) traffic.
 */
function modernProtocolVersion(message: Record<string, unknown>): string | undefined {
  const params = message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const version = (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
  return typeof version === 'string' ? version : undefined;
}

/**
 * Encode a header value per the Streamable HTTP value rules: plain visible
 * ASCII passes through; anything else (or a value that already looks like
 * the sentinel) is sent as `=?base64?{utf8-base64}?=`.
 */
export function encodeMcpHeaderValue(value: string): string {
  const needsBase64 = value.length === 0
    || (value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX))
    || value !== value.trim()
    // eslint-disable-next-line no-control-regex
    || /[^\x09\x20-\x7e]/.test(value);
  return needsBase64
    ? `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${BASE64_SENTINEL_SUFFIX}`
    : value;
}

/** Routing headers a modern request needs; they mirror the JSON-RPC body. */
export function modernRequestHeaders(message: Record<string, unknown>): Record<string, string> | undefined {
  const version = modernProtocolVersion(message);
  if (!version || typeof message.method !== 'string') return undefined;
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': version,
    'Mcp-Method': encodeMcpHeaderValue(message.method),
  };
  const nameField = MCP_NAME_SOURCE[message.method];
  const params = message.params as Record<string, unknown>;
  if (nameField && typeof params[nameField] === 'string') {
    headers['Mcp-Name'] = encodeMcpHeaderValue(params[nameField] as string);
  }
  return headers;
}

export interface BrokerProxyOptions {
  authToken?: string;
  /** Stable client identity propagated to the broker for diagnostics/audit. */
  clientId?: string;
  /** Optional tenant id forwarded to the broker HTTP transport. */
  tenantId?: string;
  /** Override fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Override stdout writer (tests). */
  write?: (chunk: string) => void;
  /**
   * #1480 S4: when the broker owner dies, re-elect instead of returning errors
   * forever. Off by default (manual `--connect-broker` daemons keep the prior
   * behavior); the auto-elect client path (S3) turns it on. When on, a confirmed
   * broker loss calls `onBrokerLost`.
   */
  reElectOnBrokerLoss?: boolean;
  /** Action on confirmed broker loss. Defaults to `process.exit(75)`. */
  onBrokerLost?: () => void;
  /** Override broker-metadata reader (tests). */
  readBrokerMetadataImpl?: (port: number, userDataDir: string) => BrokerMetadata | null;
  /** Override process liveness check (tests). */
  isPidAliveImpl?: (pid: number) => boolean;
  /**
   * Open the legacy session's GET event stream once initialize assigns an
   * Mcp-Session-Id, so a legacy host behind the broker receives progress,
   * list-changed notifications and server->client requests. Default true.
   */
  legacyEventStream?: boolean;
}

export class BrokerProxyStdioBridge {
  private readonly broker: BrokerMetadata;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly tenantId?: string;
  private readonly writeOut: (chunk: string) => void;
  private readonly reElectOnBrokerLoss: boolean;
  private readonly onBrokerLost: () => void;
  private readonly readBrokerMetadataImpl: (port: number, userDataDir: string) => BrokerMetadata | null;
  private readonly isPidAliveImpl: (pid: number) => boolean;
  private brokerLostHandled = false;
  private mcpSessionId?: string;
  /**
   * Modern requests in flight, keyed by JSON-RPC id. Modern Streamable HTTP
   * cancels a request by closing its response stream, so a host's
   * notifications/cancelled aborts the matching fetch instead of being posted.
   */
  private readonly modernInFlight = new Map<string, AbortController>();
  private readonly legacyEventStreamEnabled: boolean;
  private legacyStreamSessionId?: string;
  private legacyStreamController?: AbortController;

  constructor(broker: BrokerMetadata, authTokenOrOptions?: string | BrokerProxyOptions) {
    this.broker = broker;
    const options: BrokerProxyOptions = typeof authTokenOrOptions === 'string'
      ? { authToken: authTokenOrOptions }
      : authTokenOrOptions ?? {};
    this.authToken = options.authToken;
    this.clientId = options.clientId ?? process.env.OPENCHROME_BROKER_CLIENT_ID ?? `stdio-proxy-${process.pid}`;
    this.tenantId = options.tenantId ?? process.env.OPENCHROME_TENANT_ID;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.writeOut = options.write ?? ((chunk) => { process.stdout.write(chunk); });
    this.reElectOnBrokerLoss = options.reElectOnBrokerLoss ?? false;
    this.onBrokerLost = options.onBrokerLost ?? (() => process.exit(BROKER_REELECT_EXIT_CODE));
    this.readBrokerMetadataImpl = options.readBrokerMetadataImpl ?? readBrokerMetadata;
    this.isPidAliveImpl = options.isPidAliveImpl ?? isPidAlive;
    this.legacyEventStreamEnabled = options.legacyEventStream ?? true;
  }

  /** Stop the legacy event stream (tests and shutdown). */
  close(): void {
    this.legacyStreamController?.abort();
    this.legacyStreamController = undefined;
    this.legacyStreamSessionId = undefined;
  }

  private brokerHeaders(): Record<string, string> {
    const headers: Record<string, string> = { [BROKER_CLIENT_ID_HEADER]: this.clientId };
    if (this.tenantId) headers['X-Tenant-Id'] = this.tenantId;
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    return headers;
  }

  /**
   * Legacy Streamable HTTP delivers server-originated messages for a session
   * on its GET stream. Keep one open per session and relay it to stdout.
   */
  private ensureLegacyEventStream(sessionId: string): void {
    if (!this.legacyEventStreamEnabled || this.legacyStreamSessionId === sessionId) return;
    this.legacyStreamController?.abort();
    const controller = new AbortController();
    this.legacyStreamController = controller;
    this.legacyStreamSessionId = sessionId;
    void (async () => {
      for (let attempt = 0; attempt < 5 && !controller.signal.aborted; attempt++) {
        try {
          const response = await this.fetchImpl(this.broker.endpoint, {
            method: 'GET',
            headers: { ...this.brokerHeaders(), Accept: 'text/event-stream', [MCP_SESSION_ID_HEADER]: sessionId },
            signal: controller.signal,
          });
          const stream = (response as { body?: ReadableStream<Uint8Array> | null }).body;
          if (!response.ok || !stream || typeof stream.getReader !== 'function') return;
          attempt = 0;
          await this.relayEventStream(stream);
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    })();
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      void this.forwardLine(line);
    });
    rl.on('close', () => process.exit(0));

    // #1480 S4: idle clients should re-elect promptly when the owner dies, not
    // only on the next request. Poll the broker discovery file periodically;
    // unref so this timer never keeps the process alive on its own.
    if (this.reElectOnBrokerLoss) {
      const timer = setInterval(() => {
        if (this.isBrokerGone()) this.handleBrokerLost();
      }, 5000);
      timer.unref?.();
    }
  }

  /**
   * Has the broker owner this client attached to gone away? True when the
   * discovery file is absent or now describes a different owner (pid/endpoint),
   * i.e. a clean owner exit or a replacement. Exposed for tests.
   */
  isBrokerGone(): boolean {
    const latest = this.readBrokerMetadataImpl(this.broker.port, this.broker.userDataDir);
    return this.isDifferentBrokerOwner(latest);
  }

  private isDifferentBrokerOwner(latest: BrokerMetadata | null): boolean {
    return !latest || latest.endpoint !== this.broker.endpoint || latest.pid !== this.broker.pid;
  }

  private shouldReElectAfterForwardingFailure(): boolean {
    const latest = this.readBrokerMetadataImpl(this.broker.port, this.broker.userDataDir);
    if (this.isDifferentBrokerOwner(latest)) return true;

    // The discovery file can be left behind by a hard crash/SIGKILL. In that
    // case the metadata still names the original owner, but the forwarding
    // request just failed and the owner PID is no longer alive, so this client
    // should re-elect instead of returning transient errors forever.
    return !this.isPidAliveImpl(this.broker.pid);
  }

  private handleBrokerLost(): void {
    if (this.brokerLostHandled) return;
    this.brokerLostHandled = true;
    console.error('[openchrome] auto-elect: broker owner is gone; re-electing (host will respawn this session).');
    this.onBrokerLost();
  }

  /** Exposed for tests. */
  async forwardLine(line: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.writeResponse({ jsonrpc: '2.0', id: 0, error: { code: MCPErrorCodes.PARSE_ERROR, message: err instanceof Error ? err.message : 'Parse error' } });
      return;
    }

    const cancelled = this.cancelModernRequest(parsed);
    if (cancelled) return;

    const modernHeaders = modernRequestHeaders(parsed);
    const inFlightKey = modernHeaders && parsed.id !== undefined && parsed.id !== null
      ? JSON.stringify(parsed.id)
      : undefined;
    const controller = inFlightKey ? new AbortController() : undefined;
    if (inFlightKey && controller) this.modernInFlight.set(inFlightKey, controller);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // Streamable HTTP advertises both JSON and SSE; the server picks the
        // response framing. The proxy unwraps SSE below so stdio clients keep
        // receiving plain JSON-RPC lines.
        Accept: 'application/json, text/event-stream',
        ...this.brokerHeaders(),
      };
      if (modernHeaders) {
        // 2026-07-28 has no protocol session: never pin one to modern traffic.
        Object.assign(headers, modernHeaders);
      } else if (this.mcpSessionId) {
        headers[MCP_SESSION_ID_HEADER] = this.mcpSessionId;
      }

      const response = await this.fetchImpl(this.broker.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsed),
        ...(controller ? { signal: controller.signal } : {}),
      });

      if (!modernHeaders) {
        const sessionHeader = readHeader(response.headers, MCP_SESSION_ID_HEADER);
        if (sessionHeader) {
          this.mcpSessionId = sessionHeader;
          this.ensureLegacyEventStream(sessionHeader);
        }
      }

      if (!response.ok) {
        const text = await response.text();
        this.writeResponse({
          jsonrpc: '2.0',
          id: extractId(parsed),
          error: { code: MCPErrorCodes.INTERNAL_ERROR, message: `Broker HTTP ${response.status}: ${text}` },
        });
        return;
      }

      // 202 Accepted: notification consumed by the server, no JSON-RPC reply.
      if (response.status === 202) return;

      const contentType = readHeader(response.headers, 'Content-Type') ?? readHeader(response.headers, 'content-type') ?? '';
      const stream = (response as { body?: ReadableStream<Uint8Array> | null }).body;
      if (contentType.includes('text/event-stream') && stream && typeof stream.getReader === 'function') {
        // Relay each event as it arrives: progress for long tool calls and
        // long-lived subscriptions/listen streams must not wait for the end.
        await this.relayEventStream(stream);
        return;
      }

      const rawBody = await response.text();
      if (!rawBody) return;

      const payloads = unwrapBody(rawBody, response.headers);
      for (const payload of payloads) {
        this.writeOut(payload.trimEnd() + '\n');
      }
    } catch (err) {
      if (controller?.signal.aborted) return; // cancelled by the host
      // #1480 S4: a forwarding failure can be a transient hiccup or the owner
      // dying. Distinguish via the discovery file: if the broker is gone,
      // re-elect instead of returning errors forever. Otherwise surface the
      // transient error as before.
      if (this.reElectOnBrokerLoss && this.shouldReElectAfterForwardingFailure()) {
        this.handleBrokerLost();
        return;
      }
      this.writeResponse({
        jsonrpc: '2.0',
        id: extractId(parsed),
        error: { code: MCPErrorCodes.INTERNAL_ERROR, message: `Broker forwarding failed: ${err instanceof Error ? err.message : String(err)}` },
      });
    } finally {
      if (inFlightKey) this.modernInFlight.delete(inFlightKey);
    }
  }

  /**
   * A host's notifications/cancelled for an in-flight modern request aborts
   * that request's HTTP stream (the modern cancellation signal) and is not
   * forwarded. Returns true when it handled the message.
   */
  private cancelModernRequest(message: Record<string, unknown>): boolean {
    if (message.method !== 'notifications/cancelled' || message.id !== undefined) return false;
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return false;
    const controller = this.modernInFlight.get(JSON.stringify(requestId));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async relayEventStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flushEvents = (): void => {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        for (const payload of unwrapBody(frame, { 'content-type': 'text/event-stream' })) {
          this.writeOut(payload.trimEnd() + '\n');
        }
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flushEvents();
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      buffer += '\n\n';
      flushEvents();
    }
  }

  private writeResponse(response: MCPResponse): void {
    this.writeOut(JSON.stringify(response) + '\n');
  }
}

function readHeader(headers: Headers | Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const map = headers as Record<string, string>;
  return map[name] ?? map[name.toLowerCase()];
}

function extractId(parsed: Record<string, unknown>): string | number | null {
  const id = parsed.id;
  return (typeof id === 'string' || typeof id === 'number' || id === null) ? id : 0;
}

function unwrapBody(rawBody: string, headers: Headers | Record<string, string> | undefined): string[] {
  const contentType = readHeader(headers, 'Content-Type') ?? readHeader(headers, 'content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return rawBody ? [rawBody] : [];

  // Streamable HTTP framing: one or more `event:`/`data:` pairs separated by
  // blank lines. Each `data:` payload is a complete JSON-RPC response, so
  // emit them as separate lines instead of concatenating (which would
  // produce invalid JSON for batched responses).
  const dataLines: string[] = [];
  for (const line of rawBody.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  return dataLines;
}
