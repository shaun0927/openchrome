import type { BridgeResponse, BrowserUseBridgeTransport } from '../adapters/browser-use-adapter';

export interface BrowserUseNativeResult { library: 'browser-use'; mode: 'native'; taskId: string; status: 'passed' | 'failed' | 'timeout'; finalText: string; trace: unknown[]; failureCategory?: string; }

export async function runBrowserUseNativeTask(transport: BrowserUseBridgeTransport, task: { id: string; startUrl: string; goal: string }, timeoutMs = 60000): Promise<BrowserUseNativeResult> {
  try {
    await transport.start();
    const response: BridgeResponse = await transport.send({ id: 1, method: 'run_task' as never, args: { startUrl: task.startUrl, instruction: task.goal, timeoutMs } });
    if (!response.ok) return { library: 'browser-use', mode: 'native', taskId: task.id, status: 'failed', finalText: '', trace: [], failureCategory: response.error ?? 'browser-use bridge error' };
    const result = response.result ?? {};
    const rawStatus = result.status === 'passed' || result.status === 'timeout' ? result.status : 'failed';
    return {
      library: 'browser-use',
      mode: 'native',
      taskId: task.id,
      status: rawStatus,
      finalText: String(result.finalText ?? ''),
      trace: Array.isArray(result.trace) ? result.trace : [],
      ...(rawStatus !== 'passed' && { failureCategory: String(result.failureCategory ?? rawStatus) }),
    };
  } catch (err) {
    return { library: 'browser-use', mode: 'native', taskId: task.id, status: 'failed', finalText: '', trace: [], failureCategory: err instanceof Error ? err.message : String(err) };
  } finally {
    await transport.stop().catch(() => undefined);
  }
}
