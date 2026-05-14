import type { MCPToolResult } from './mcp-client';

export interface ToolCallClient {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPToolResult>;
}

export interface CountedToolCall {
  name: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  ok: boolean;
  isError?: boolean;
  error?: string;
}

export interface ToolCallMeasurement {
  label: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  count: number;
  calls: CountedToolCall[];
}

/**
 * Counts real MCP tool calls between explicit markers for #717 e2e phases.
 *
 * The wrapper preserves the MCPClient/HttpMCPClient callTool contract so specs
 * can swap it in without changing browser-server wiring. It records thrown
 * client errors and MCP tool-level isError results as calls because both still
 * consume a tool-call slot in the skill-resume acceptance metric.
 */
export class ToolCallCounter implements ToolCallClient {
  private readonly client: ToolCallClient;
  private activeLabel: string | null = null;
  private activeStartedAt = 0;
  private calls: CountedToolCall[] = [];

  constructor(client: ToolCallClient) {
    this.client = client;
  }

  start(label: string): void {
    if (this.activeLabel) {
      throw new Error(`ToolCallCounter already active for "${this.activeLabel}"`);
    }
    this.activeLabel = label;
    this.activeStartedAt = Date.now();
    this.calls = [];
  }

  stop(): ToolCallMeasurement {
    if (!this.activeLabel) {
      throw new Error('ToolCallCounter is not active');
    }
    const endedAt = Date.now();
    const measurement: ToolCallMeasurement = {
      label: this.activeLabel,
      startedAt: this.activeStartedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - this.activeStartedAt),
      count: this.calls.length,
      calls: this.calls.slice(),
    };
    this.activeLabel = null;
    this.activeStartedAt = 0;
    this.calls = [];
    return measurement;
  }

  async measure<T>(label: string, fn: (client: ToolCallClient) => Promise<T>): Promise<{ result: T; measurement: ToolCallMeasurement }> {
    this.start(label);
    try {
      const result = await fn(this);
      return { result, measurement: this.stop() };
    } catch (error) {
      const measurement = this.stop();
      (error as Error & { toolCallMeasurement?: ToolCallMeasurement }).toolCallMeasurement = measurement;
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<MCPToolResult> {
    const startedAt = Date.now();
    try {
      const result = await this.client.callTool(name, args, timeoutMs);
      this.record({ name, args, timeoutMs, startedAt, result });
      return result;
    } catch (error) {
      this.record({ name, args, timeoutMs, startedAt, error });
      throw error;
    }
  }

  snapshot(): CountedToolCall[] {
    return this.calls.slice();
  }

  get count(): number {
    return this.calls.length;
  }

  private record(input: {
    name: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
    startedAt: number;
    result?: MCPToolResult;
    error?: unknown;
  }): void {
    if (!this.activeLabel) return;
    const endedAt = Date.now();
    this.calls.push({
      name: input.name,
      args: { ...input.args },
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      startedAt: input.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - input.startedAt),
      ok: !input.error && input.result?.raw?.isError !== true,
      ...(input.result?.raw?.isError === true ? { isError: true } : {}),
      ...(input.error ? { error: input.error instanceof Error ? input.error.message : String(input.error) } : {}),
    });
  }
}

export function medianToolCallCount(measurements: Array<{ count: number }>): number {
  if (measurements.length === 0) {
    throw new Error('medianToolCallCount requires at least one measurement');
  }
  const sorted = measurements.map((m) => m.count).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
