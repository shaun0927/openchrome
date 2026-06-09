import * as readline from 'readline';
import type { BrokerMetadata } from '../broker/discovery';
import { readBrokerMetadata } from '../broker/discovery';
import { MCPErrorCodes, MCPResponse } from '../types/mcp';
import { isPidAlive } from '../utils/controller-lock';

/**
 * Exit code a re-electing client uses when it detects its broker owner has died.
 * The MCP host respawns the stdio server, which re-runs the controller-lock
 * election (#1480 S2/S3) and — with the old owner gone — typically wins and
 * becomes the new owner, removing the single-point-of-failure (#1480 S4).
 */
export const BROKER_REELECT_EXIT_CODE = 75;

const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';
export const BROKER_CLIENT_ID_HEADER = 'X-OpenChrome-Broker-Client-Id';

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

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // Streamable HTTP advertises both JSON and SSE; the server picks the
        // response framing. The proxy unwraps SSE below so stdio clients keep
        // receiving plain JSON-RPC lines.
        Accept: 'application/json, text/event-stream',
        [BROKER_CLIENT_ID_HEADER]: this.clientId,
      };
      if (this.tenantId) headers['X-Tenant-Id'] = this.tenantId;
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      if (this.mcpSessionId) headers[MCP_SESSION_ID_HEADER] = this.mcpSessionId;

      const response = await this.fetchImpl(this.broker.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsed),
      });

      const sessionHeader = readHeader(response.headers, MCP_SESSION_ID_HEADER);
      if (sessionHeader) this.mcpSessionId = sessionHeader;

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

      const rawBody = await response.text();
      if (!rawBody) return;

      const payloads = unwrapBody(rawBody, response.headers);
      for (const payload of payloads) {
        this.writeOut(payload.trimEnd() + '\n');
      }
    } catch (err) {
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
