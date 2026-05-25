import type { MCPToolResult } from '../benchmark-runner';

export interface NativeToolEvent { tool: string; ok: boolean; text?: string; error?: string; }
export interface NativeEpisodeResult { library: 'playwright-mcp'; mode: 'native'; taskId: string; status: 'passed' | 'failed' | 'unsupported' | 'timeout'; trace: NativeToolEvent[]; finalText: string; failureCategory?: string; }
export interface PlaywrightMcpNativeTransport { listTools(): Promise<Iterable<string>>; callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>; }

function goalSatisfied(text: string, task: { goal: string; successText?: string; successCriteria?: string[] }): boolean {
  const criteria = task.successCriteria?.length ? task.successCriteria : [task.successText ?? task.goal];
  return criteria.every((criterion) => text.toLocaleLowerCase().includes(criterion.toLocaleLowerCase()));
}

const REQUIRED = ['browser_navigate', 'browser_snapshot'];

function discoveredToolSet(tools: Iterable<string>): Set<string> {
  return tools instanceof Set ? tools : new Set(Array.from(tools));
}

export async function runPlaywrightMcpNativeTask(transport: PlaywrightMcpNativeTransport, task: { id: string; startUrl: string; goal: string; successText?: string; successCriteria?: string[] }): Promise<NativeEpisodeResult> {
  const trace: NativeToolEvent[] = [];
  try {
    const tools = discoveredToolSet(await transport.listTools());
    const missing = REQUIRED.filter((tool) => !tools.has(tool));
    if (missing.length > 0) return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'unsupported', trace, finalText: '', failureCategory: `missing tools: ${missing.join(', ')}` };
    const nav = await transport.callTool('browser_navigate', { url: task.startUrl });
    trace.push({ tool: 'browser_navigate', ok: !nav.isError, text: nav.content?.[0]?.text });
    if (nav.isError) return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'failed', trace, finalText: '', failureCategory: 'navigation' };
    const snapshot = await transport.callTool('browser_snapshot', {});
    const text = snapshot.content?.map((c) => c.text ?? '').join('\n') ?? '';
    trace.push({ tool: 'browser_snapshot', ok: !snapshot.isError, text });
    if (snapshot.isError) return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'failed', trace, finalText: text, failureCategory: 'snapshot' };
    if (!goalSatisfied(text, task)) return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'failed', trace, finalText: text, failureCategory: 'postcondition' };
    return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'passed', trace, finalText: text };
  } catch (err) {
    trace.push({ tool: 'transport', ok: false, error: err instanceof Error ? err.message : String(err) });
    return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'failed', trace, finalText: '', failureCategory: 'infrastructure' };
  }
}
