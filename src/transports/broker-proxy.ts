import * as readline from 'readline';
import type { BrokerMetadata } from '../broker/discovery';
import { MCPErrorCodes, MCPResponse } from '../types/mcp';

export class BrokerProxyStdioBridge {
  private readonly broker: BrokerMetadata;
  private readonly authToken?: string;

  constructor(broker: BrokerMetadata, authToken?: string) {
    this.broker = broker;
    this.authToken = authToken;
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      void this.forwardLine(line);
    });
    rl.on('close', () => process.exit(0));
  }

  private async forwardLine(line: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.write({ jsonrpc: '2.0', id: 0, error: { code: MCPErrorCodes.PARSE_ERROR, message: err instanceof Error ? err.message : 'Parse error' } });
      return;
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const response = await fetch(this.broker.endpoint, { method: 'POST', headers, body: JSON.stringify(parsed) });
      const text = await response.text();
      if (!response.ok) {
        this.write({ jsonrpc: '2.0', id: parsed.id as string | number | null ?? 0, error: { code: MCPErrorCodes.INTERNAL_ERROR, message: `Broker HTTP ${response.status}: ${text}` } });
        return;
      }
      process.stdout.write(text.trimEnd() + '\n');
    } catch (err) {
      this.write({ jsonrpc: '2.0', id: parsed.id as string | number | null ?? 0, error: { code: MCPErrorCodes.INTERNAL_ERROR, message: `Broker forwarding failed: ${err instanceof Error ? err.message : String(err)}` } });
    }
  }

  private write(response: MCPResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}
