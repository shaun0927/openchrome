import { BenchmarkTask, MCPAdapter, MCPToolResult, TaskResult } from './benchmark-runner';
import { measureCall } from './utils';

export type BenchmarkCategory =
  | 'cold-start'
  | 'read-page'
  | 'interactive'
  | 'action'
  | 'screenshot'
  | 'agent-loop'
  | 'parallel-tabs';

export interface BenchmarkMatrixScenario {
  name: string;
  category: BenchmarkCategory;
  description: string;
  steps: Array<{ tool: string; args: Record<string, unknown>; tabAlias?: string }>;
}

export interface MatrixFilter {
  category?: string;
}

export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function responsePayloadSize(result: MCPToolResult): { responseChars: number; screenshotBytes: number } {
  let responseChars = 0;
  let screenshotBytes = 0;

  for (const item of result.content ?? []) {
    if (typeof item.text === 'string') {
      responseChars += item.text.length;
    }
    if (typeof item.data === 'string') {
      responseChars += item.data.length;
      screenshotBytes += Buffer.byteLength(item.data, 'base64');
    }
  }

  return { responseChars, screenshotBytes };
}

function extractTabId(result: MCPToolResult): string | undefined {
  for (const item of result.content ?? []) {
    if (typeof item.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text) as { tabId?: unknown };
      if (typeof parsed.tabId === 'string' && parsed.tabId.length > 0) return parsed.tabId;
    } catch {
      // Ignore non-JSON text payloads.
    }
  }
  return undefined;
}

function tabPlaceholders(scenario: BenchmarkMatrixScenario): string[] {
  return Array.from(new Set(scenario.steps
    .map((step) => step.tabAlias)
    .filter((tabAlias): tabAlias is string => typeof tabAlias === 'string' && tabAlias.length > 0)));
}

function setupUrlForScenario(scenario: BenchmarkMatrixScenario): string {
  if (scenario.category !== 'action' && scenario.category !== 'agent-loop') return 'about:blank';
  const html = '<!doctype html><html><body><label>Email <input aria-label="Email"></label><button>Submit</button></body></html>';
  return `data:text/html,${encodeURIComponent(html)}`;
}

export function createBenchmarkMatrix(): BenchmarkMatrixScenario[] {
  return [
    {
      name: 'cold-start-first-tab',
      category: 'cold-start',
      description: 'Session/server init to first usable tab',
      steps: [{ tool: 'tabs_create', args: { url: 'about:blank' } }],
    },
    {
      name: 'warm-read-page-dom',
      category: 'read-page',
      description: 'Warm DOM read_page latency and payload size',
      steps: [{ tool: 'read_page', tabAlias: 'primary', args: { mode: 'dom' } }],
    },
    {
      name: 'warm-read-page-ax',
      category: 'read-page',
      description: 'Warm AX read_page latency and payload size',
      steps: [{ tool: 'read_page', tabAlias: 'primary', args: { mode: 'ax' } }],
    },
    {
      name: 'warm-read-page-dom-delta',
      category: 'read-page',
      description: 'Warm DOM delta read_page latency and payload size',
      steps: [
        { tool: 'read_page', tabAlias: 'primary', args: { mode: 'dom' } },
        { tool: 'read_page', tabAlias: 'primary', args: { mode: 'dom', compression: 'delta' } },
      ],
    },
    {
      name: 'interactive-discovery',
      category: 'interactive',
      description: 'Interactive-only discovery payload and latency',
      steps: [{ tool: 'read_page', tabAlias: 'primary', args: { mode: 'dom', filter: 'interactive' } }],
    },
    {
      name: 'click-fill-action-latency',
      category: 'action',
      description: 'Click/fill action latency in a simple action loop',
      steps: [
        { tool: 'act', tabAlias: 'primary', args: { instruction: 'click Submit' } },
        { tool: 'act', tabAlias: 'primary', args: { instruction: 'type benchmark into Email' } },
      ],
    },
    {
      name: 'screenshot-inline-payload',
      category: 'screenshot',
      description: 'Screenshot latency and inline base64 payload size',
      steps: [{ tool: 'page_screenshot', tabAlias: 'primary', args: { fullPage: false } }],
    },
    {
      name: 'agent-loop-read-action-delta',
      category: 'agent-loop',
      description: 'Representative read_page -> action -> read_page(delta) loop',
      steps: [
        { tool: 'read_page', tabAlias: 'primary', args: { mode: 'dom' } },
        { tool: 'act', tabAlias: 'primary', args: { instruction: 'click Submit' } },
        { tool: 'read_page', tabAlias: 'primary', args: { mode: 'dom', compression: 'delta' } },
      ],
    },
    ...[1, 5, 20].map((tabs) => ({
      name: `parallel-tabs-${tabs}`,
      category: 'parallel-tabs' as const,
      description: `Parallel tab read smoke with ${tabs} tab(s)`,
      steps: Array.from({ length: tabs }, (_, i) => ({
        tool: 'read_page',
        tabAlias: `parallel-${i + 1}`,
        args: { mode: 'dom' },
      })),
    })),
  ];
}

export function filterBenchmarkMatrix(
  scenarios: BenchmarkMatrixScenario[],
  filter: MatrixFilter = {},
): BenchmarkMatrixScenario[] {
  if (!filter.category) return scenarios;
  return scenarios.filter((scenario) => scenario.category === filter.category || scenario.name === filter.category);
}

export function createMatrixTask(scenario: BenchmarkMatrixScenario): BenchmarkTask {
  return {
    name: scenario.name,
    description: scenario.description,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      let startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };
      let responseChars = 0;
      let screenshotBytes = 0;
      const createdTabIds: string[] = [];

      try {
        const tabIds = new Map<string, string>();
        for (const placeholder of tabPlaceholders(scenario)) {
          const args = { url: setupUrlForScenario(scenario) };
          const result = await adapter.callTool('tabs_create', args);
          if (result.isError) {
            const text = result.content?.find((item) => typeof item.text === 'string')?.text;
            throw new Error(`Benchmark step failed: tabs_create${text ? ` — ${text.slice(0, 160)}` : ''}`);
          }
          const tabId = extractTabId(result);
          if (!tabId) {
            throw new Error(`Benchmark scenario ${scenario.name} could not resolve tab alias ${placeholder}: tabs_create returned no tabId`);
          }
          tabIds.set(placeholder, tabId);
          createdTabIds.push(tabId);
        }
        startTime = Date.now();

        const runStep = async (step: BenchmarkMatrixScenario['steps'][number]) => {
          const args = { ...step.args };
          if (typeof step.tabAlias === 'string') {
            const tabId = tabIds.get(step.tabAlias);
            if (!tabId) {
              throw new Error(`Benchmark scenario ${scenario.name} did not create tab alias: ${step.tabAlias}`);
            }
            args.tabId = tabId;
          }
          const result = await adapter.callTool(step.tool, args);
          if (result.isError) {
            const text = result.content?.find((item) => typeof item.text === 'string')?.text;
            throw new Error(`Benchmark step failed: ${step.tool}${text ? ` — ${text.slice(0, 160)}` : ''}`);
          }
          measureCall(result, args, counters);
          const payload = responsePayloadSize(result);
          responseChars += payload.responseChars;
          screenshotBytes += payload.screenshotBytes;
          if (step.tool === 'tabs_create') {
            const createdTabId = extractTabId(result);
            if (!createdTabId) {
              throw new Error(`Benchmark step failed: tabs_create returned no tabId for cleanup`);
            }
            createdTabIds.push(createdTabId);
          }
        };

        if (scenario.category === 'parallel-tabs') {
          const settled = await Promise.allSettled(scenario.steps.map(runStep));
          const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
          if (rejected) {
            throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
          }
        } else {
          for (const step of scenario.steps) {
            await runStep(step);
          }
        }

        await closeCreatedTabs(adapter, createdTabIds);
        const nodeRssBytes = process.memoryUsage().rss;
        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          responseChars,
          estimatedOutputTokens: estimateTokensFromChars(responseChars || counters.outputChars),
          screenshotBytes,
          nodeRssBytes,
          chromeRssBytes: null,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            category: scenario.category,
            chromeRssUnavailableReason: 'stub and portable benchmark paths do not own a Chrome process tree',
          },
        };
      } catch (error) {
        await closeCreatedTabs(adapter, createdTabIds);
        return {
          success: false,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          responseChars,
          estimatedOutputTokens: estimateTokensFromChars(responseChars || counters.outputChars),
          screenshotBytes,
          nodeRssBytes: process.memoryUsage().rss,
          chromeRssBytes: null,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
          metadata: { category: scenario.category },
        };
      }
    },
  };
}

async function closeCreatedTabs(adapter: MCPAdapter, tabIds: string[]): Promise<void> {
  if (tabIds.length === 0) return;
  await Promise.allSettled(tabIds.map((tabId) => adapter.callTool('tabs_close', { tabId })));
}

export function createMatrixTasks(filter: MatrixFilter = {}): BenchmarkTask[] {
  return filterBenchmarkMatrix(createBenchmarkMatrix(), filter).map(createMatrixTask);
}
