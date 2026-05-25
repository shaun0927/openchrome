import type { EvalContext } from '../../../../src/contracts/eval-context';
import type { MCPAdapter, MCPToolResult } from '../../benchmark-runner';
import { BrowserUseAdapter, OpenChromeRealAdapter, PlaywrightMcpAdapter } from '../../adapters';
import { runAnthropicToolUseLoop, type AnthropicMessagesClient } from '../../llm-provider/anthropic-loop';
import { runOpenAiToolUseLoop, type OpenAiResponsesClient } from '../../llm-provider/openai-loop';
import type { BudgetCaps } from './budget';
import type { WebVoyagerTask } from '../types';
import type { WebVoyagerLibrary } from './library-routing';

export type LiveProviderAdapter = 'claude' | 'openai';

export interface LiveTaskRunnerResult {
  context: EvalContext;
  tool_calls: number;
  response_bytes: number;
  usd_spent: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  aborted?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS' | 'API_ERROR';
}

export interface LiveTaskRunnerOptions {
  provider: LiveProviderAdapter;
  library: WebVoyagerLibrary;
  task: WebVoyagerTask;
  budget: BudgetCaps;
  model: string;
  anthropicClient?: AnthropicMessagesClient;
  openAiClient?: OpenAiResponsesClient;
  adapter?: MCPAdapter;
}

export const WEBVOYAGER_TOOLS = [
  {
    name: 'tabs_create',
    description: 'Open a new browser tab at the requested URL and return a tabId.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description: 'Read the current browser page payload for a tabId.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tabs_close',
    description: 'Close a browser tab by tabId.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
] as const;

function textFromResult(result: MCPToolResult): string {
  return (result.content || []).map((part) => part.text ?? part.data ?? '').filter(Boolean).join('\n');
}

function parseTabId(result: MCPToolResult): string | null {
  try {
    const parsed = JSON.parse(textFromResult(result));
    return typeof parsed.tabId === 'string' && parsed.tabId.length > 0 ? parsed.tabId : null;
  } catch {
    return null;
  }
}

export class CapturingBenchmarkAdapter implements MCPAdapter {
  readonly name: string;
  readonly mode: string;
  readonly kind?: MCPAdapter['kind'];
  readonly version?: string;
  private lastTabId: string | null = null;
  private lastUrl = '';
  private lastPayload = '';
  private networkLog: Array<{ url: string; status: number; ts: number }> = [];

  constructor(private readonly inner: MCPAdapter) {
    this.name = inner.name;
    this.mode = inner.mode;
    this.kind = inner.kind;
    this.version = inner.version;
  }

  async setup(): Promise<void> { await this.inner.setup?.(); }
  async teardown(): Promise<void> { await this.inner.teardown?.(); }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const result = await this.inner.callTool(toolName, args);
    if (toolName === 'tabs_create') {
      const tabId = parseTabId(result);
      if (tabId) this.lastTabId = tabId;
      if (typeof args.url === 'string') {
        this.lastUrl = args.url;
        this.networkLog.push({ url: args.url, status: result.isError ? 0 : 200, ts: Date.now() });
      }
    }
    if (toolName === 'read_page') this.lastPayload = textFromResult(result);
    return result;
  }

  async ensureFinalPayload(): Promise<void> {
    if (!this.lastTabId || this.lastPayload.trim().length > 0) return;
    try {
      const result = await this.callTool('read_page', { tabId: this.lastTabId });
      this.lastPayload = textFromResult(result);
    } catch {
      // Contract evaluation will fail honestly if the final payload cannot be read.
    }
  }

  evalContext(finalText: string): EvalContext {
    const payload = () => [this.lastPayload, finalText].filter((s) => s && s.trim().length > 0).join('\n');
    return {
      url: async () => this.lastUrl,
      domText: async () => payload() || null,
      domCount: async () => 0,
      networkSince: async () => this.networkLog,
      screenshotPng: async () => null,
      hasOpenDialog: async () => false,
    };
  }
}

export function createLibraryAdapter(library: WebVoyagerLibrary): MCPAdapter {
  const cdpEndpoint = process.env.OPENCHROME_BENCH_CDP_ENDPOINT;
  if (library === 'openchrome') return new OpenChromeRealAdapter({ mode: 'dom', cdpEndpoint });
  if (library === 'playwright-mcp') return new PlaywrightMcpAdapter({ cdpEndpoint, serverPath: process.env.PLAYWRIGHT_MCP_SERVER_PATH });
  return new BrowserUseAdapter({ bridgeScriptPath: process.env.BROWSER_USE_BRIDGE_SCRIPT, python: process.env.BROWSER_USE_PYTHON });
}

function systemPrompt(library: WebVoyagerLibrary): string {
  return [
    'You are running a browser benchmark task. Use only the provided browser tools.',
    'Open the target page, read the page, and stop once the requested information is available.',
    'Do not invent browser state; the deterministic contract evaluator will check the final page state.',
    `Library under test: ${library}.`,
  ].join('\n');
}

export async function runLiveWebVoyagerTask(options: LiveTaskRunnerOptions): Promise<LiveTaskRunnerResult> {
  const adapter = new CapturingBenchmarkAdapter(options.adapter ?? createLibraryAdapter(options.library));
  await adapter.setup?.();
  try {
    const tools = WEBVOYAGER_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> }));
    const common = { adapter, model: options.model, user: options.task.instruction, tools, budget: options.budget };
    const loop = options.provider === 'claude'
      ? await runAnthropicToolUseLoop({ ...common, client: options.anthropicClient ?? createAnthropicClient(), system: systemPrompt(options.library) })
      : await runOpenAiToolUseLoop({ ...common, client: options.openAiClient ?? createOpenAiClient(), instructions: systemPrompt(options.library) });
    await adapter.ensureFinalPayload();
    const inputTokens = loop.turns.reduce((sum, turn) => sum + turn.usage.inputTokens, 0);
    const outputTokens = loop.turns.reduce((sum, turn) => sum + turn.usage.outputTokens, 0);
    const responseBytes = loop.toolResults.reduce((sum, result) => sum + Buffer.byteLength(textFromResult(result)), 0) + Buffer.byteLength(loop.finalText);
    return {
      context: adapter.evalContext(loop.finalText),
      tool_calls: loop.toolResults.length,
      response_bytes: responseBytes,
      usd_spent: loop.usdSpent,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: loop.totalTokens,
      ...(loop.aborted && { aborted: loop.aborted }),
    };
  } catch (err) {
    if (err instanceof Error && /budget|iteration/i.test(err.message)) throw err;
    throw err;
  } finally {
    await adapter.teardown?.();
  }
}

function createAnthropicClient(): AnthropicMessagesClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@anthropic-ai/sdk');
  const Anthropic = mod.default ?? mod;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return { create: (input) => client.messages.create(input) };
}

function createOpenAiClient(): OpenAiResponsesClient {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('openai');
    const OpenAI = mod.default ?? mod;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return { create: (input) => client.responses.create(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `openai package is not installed. Install it as a dev dep before ` +
        `running the real adapter: npm i -D openai. Original error: ${message}`,
    );
  }
}
