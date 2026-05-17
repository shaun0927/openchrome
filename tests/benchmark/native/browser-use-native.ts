import type { BridgeResponse, BrowserUseBridgeTransport } from '../adapters/browser-use-adapter';

let requestSeq = 0;
const lifecycleState = new WeakMap<BrowserUseBridgeTransport, { active: number; startup?: Promise<void> }>();

function nextRequestId(): number {
  requestSeq = (requestSeq % Number.MAX_SAFE_INTEGER) + 1;
  return requestSeq;
}

function isTimeoutText(value: unknown): boolean {
  return /timeout|timed out/i.test(String(value));
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) return isTimeoutText(err.message) || isTimeoutText(err.name) || isTimeoutText((err as { code?: unknown }).code);
  return isTimeoutText(err);
}

function timeoutResult(taskId: string): BrowserUseNativeResult {
  return { library: 'browser-use', mode: 'native', taskId, status: 'timeout', finalText: '', trace: [], failureCategory: 'timeout' };
}

export interface BrowserUseNativeResult { library: 'browser-use'; mode: 'native'; taskId: string; status: 'passed' | 'failed' | 'timeout'; finalText: string; trace: unknown[]; failureCategory?: string; }

export async function runBrowserUseNativeTask(transport: BrowserUseBridgeTransport, task: { id: string; startUrl: string; goal: string }, timeoutMs = 60000): Promise<BrowserUseNativeResult> {
  const lifecycle = lifecycleState.get(transport) ?? { active: 0 };
  lifecycle.active += 1;
  if (!lifecycle.startup) lifecycle.startup = transport.start();
  lifecycleState.set(transport, lifecycle);
  try {
    await lifecycle.startup;
    const response: BridgeResponse = await transport.send({ id: nextRequestId(), method: 'run_task' as never, args: { startUrl: task.startUrl, instruction: task.goal, timeoutMs } });
    if (!response.ok) {
      if (isTimeoutText(response.error)) return timeoutResult(task.id);
      return { library: 'browser-use', mode: 'native', taskId: task.id, status: 'failed', finalText: '', trace: [], failureCategory: response.error ?? 'browser-use bridge error' };
    }
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
    if (isTimeoutError(err)) return timeoutResult(task.id);
    return { library: 'browser-use', mode: 'native', taskId: task.id, status: 'failed', finalText: '', trace: [], failureCategory: err instanceof Error ? err.message : String(err) };
  } finally {
    lifecycle.active -= 1;
    if (lifecycle.active === 0) {
      lifecycleState.delete(transport);
      await transport.stop().catch(() => undefined);
    }
  }
}
