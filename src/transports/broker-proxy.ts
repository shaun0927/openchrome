import * as readline from 'readline';
import type { BrokerMetadata } from '../broker/discovery';
import { MCPErrorCodes, MCPResponse } from '../types/mcp';

const MCP_SESSION_ID_HEADER = 'Mcp-Session-Id';

export interface BrokerProxyOptions {
  authToken?: string;
  /** Override fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Override stdout writer (tests). */
  write?: (chunk: string) => void;
}

export class BrokerProxyStdioBridge {
  private readonly broker: BrokerMetadata;
  private readonly authToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly writeOut: (chunk: string) => void;
  private mcpSessionId?: string;

  constructor(broker: BrokerMetadata, authTokenOrOptions?: string | BrokerProxyOptions) {
    this.broker = broker;
    const options: BrokerProxyOptions = typeof authTokenOrOptions === 'string'
      ? { authToken: authTokenOrOptions }
      : authTokenOrOptions ?? {};
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.writeOut = options.write ?? ((chunk) => { process.stdout.write(chunk); });
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      void this.forwardLine(line);
    });
    rl.on('close', () => process.exit(0));
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
      };
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

      const payload = unwrapBody(rawBody, response.headers);
      if (!payload) return;
      this.writeOut(payload.trimEnd() + '\n');
    } catch (err) {
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

function unwrapBody(rawBody: string, headers: Headers | Record<string, string> | undefined): string | null {
  const contentType = readHeader(headers, 'Content-Type') ?? readHeader(headers, 'content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return rawBody;

  // Streamable HTTP single-response framing: one `event:` line followed by
  // one or more `data:` lines. Concatenate `data:` payloads and drop the rest.
  const dataLines: string[] = [];
  for (const line of rawBody.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('');
}
