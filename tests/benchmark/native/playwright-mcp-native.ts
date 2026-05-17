import type { MCPToolResult } from '../benchmark-runner';

export interface NativeToolEvent { tool: string; ok: boolean; text?: string; error?: string; }
export interface NativeEpisodeResult { library: 'playwright-mcp'; mode: 'native'; taskId: string; status: 'passed' | 'failed' | 'unsupported' | 'timeout'; trace: NativeToolEvent[]; finalText: string; failureCategory?: string; }
export interface PlaywrightMcpNativeTransport { listTools(): Promise<string[]>; callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>; }

const REQUIRED = ['browser_navigate', 'browser_snapshot'];

export async function runPlaywrightMcpNativeTask(transport: PlaywrightMcpNativeTransport, task: { id: string; startUrl: string; goal: string }): Promise<NativeEpisodeResult> {
  const tools = await transport.listTools();
  const missing = REQUIRED.filter((tool) => !tools.includes(tool));
  if (missing.length > 0) return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'unsupported', trace: [], finalText: '', failureCategory: `missing tools: ${missing.join(', ')}` };
  const trace: NativeToolEvent[] = [];
  try {
    const nav = await transport.callTool('browser_navigate', { url: task.startUrl });
    trace.push({ tool: 'browser_navigate', ok: !nav.isError, text: nav.content?.[0]?.text });
    if (nav.isError) return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'failed', trace, finalText: '', failureCategory: 'navigation' };
    const snapshot = await transport.callTool('browser_snapshot', {});
    const text = snapshot.content?.map((c) => c.text ?? '').join('\n') ?? '';
    trace.push({ tool: 'browser_snapshot', ok: !snapshot.isError, text });
    return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: snapshot.isError ? 'failed' : 'passed', trace, finalText: text, ...(snapshot.isError && { failureCategory: 'snapshot' }) };
  } catch (err) {
    trace.push({ tool: 'transport', ok: false, error: err instanceof Error ? err.message : String(err) });
    return { library: 'playwright-mcp', mode: 'native', taskId: task.id, status: 'failed', trace, finalText: '', failureCategory: 'infrastructure' };
  }
}
