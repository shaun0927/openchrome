import { MCPAdapter, MCPToolResult } from '../benchmark-runner';

export interface OpenChromeAdapterOptions {
  mode: 'ax' | 'dom';
  serverUrl?: string; // for future remote server support
}

export class OpenChromeAdapter implements MCPAdapter {
  name = 'OpenChrome';
  mode: string;
  private options: OpenChromeAdapterOptions;

  private _totalInputChars = 0;
  private _totalOutputChars = 0;
  private _toolCallCount = 0;

  constructor(options: OpenChromeAdapterOptions) {
    this.options = options;
    this.mode = options.mode;
  }

  async setup(): Promise<void> {
    this.resetMetrics();
  }

  async teardown(): Promise<void> {
    // No-op for now
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const inputJson = JSON.stringify({ tool: toolName, args });
    this._totalInputChars += inputJson.length;

    // TODO: Wire to actual MCP server
    const result: MCPToolResult = {
      content: [{ type: 'text', text: 'stub response' }],
    };

    const outputJson = JSON.stringify(result);
    this._totalOutputChars += outputJson.length;
    this._toolCallCount += 1;

    return result;
  }

  get totalInputChars(): number {
    return this._totalInputChars;
  }

  get totalOutputChars(): number {
    return this._totalOutputChars;
  }

  get toolCallCount(): number {
    return this._toolCallCount;
  }

  resetMetrics(): void {
    this._totalInputChars = 0;
    this._totalOutputChars = 0;
    this._toolCallCount = 0;
  }
}
