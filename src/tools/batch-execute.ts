/**
 * Batch Execute Tool - Execute JavaScript across multiple tabs in parallel
 *
 * Eliminates agent spawn overhead by running scripts directly via CDP,
 * bypassing the need for individual Claude agent instances per tab.
 *
 * Performance impact: Reduces Phase 2 (agent spawn) from ~109s to ~0s
 */

import { MCPServer } from '../mcp-server';
import {
  MCPToolDefinition,
  MCPResult,
  ToolContext,
  ToolHandler,
  getRemainingBudget,
  throwIfAborted,
} from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import {
  CDPEvalResult,
  formatCDPResult,
  JavascriptCDPSendOptions,
  normalizeJavascriptTimeoutMs,
} from './javascript';
import { getMetricsCollector } from '../metrics/collector';
import { LruTtlCache } from '../core/idempotency/lru';
import { OpenChromeTimeoutError } from '../errors/timeout';
import {
  addTimeoutResponseGraceMs,
  getEffectiveTimeoutMs,
  getRemainingTimeoutMs,
  getTimeoutDeadlineAt,
  withTimeout,
} from '../utils/with-timeout';

const definition: MCPToolDefinition = {
  name: 'batch_execute',
  description: 'Execute JS across multiple tabs in parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'Tasks to execute in parallel',
        items: {
          type: 'object',
          properties: {
            tabId: {
              type: 'string',
              description: 'Tab ID',
            },
            workerId: {
              type: 'string',
              description: 'Worker ID for result tracking',
            },
            script: {
              type: 'string',
              description: 'JS code. Promises auto-awaited',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in ms. Default: 30000',
            },
            idempotencyKey: {
              type: 'string',
              description: 'Optional per-session key. Successful prior result is reused within TTL.',
            },
            interItemWaitMs: {
              type: 'number',
              description: 'Sequential mode only: wait this many ms after this item before next item.',
            },
            interItemWaitFor: {
              type: 'object',
              description: 'Sequential mode only: wait_for-like condition after this item before next item.',
            },
          },
          required: ['tabId', 'script'],
        },
      },
      concurrency: {
        type: 'number',
        description: 'Max parallel tasks. Default: 10',
      },
      failFast: {
        type: 'boolean',
        description: 'Stop on first failure. Default: false',
      },
    },
    required: ['tasks'],
  },
  annotations: TOOL_ANNOTATIONS.batch_execute,
};

interface WaitForSpec {
  type: 'selector' | 'selector_hidden' | 'function' | 'navigation' | 'url_match' | 'timeout';
  value?: string;
  timeout?: number;
  visible?: boolean;
  pollIntervalMs?: number;
}

interface BatchTask {
  tabId: string;
  workerId?: string;
  script: string;
  timeout?: number;
  idempotencyKey?: string;
  interItemWaitMs?: number;
  interItemWaitFor?: WaitForSpec;
}

interface BatchTaskResult {
  tabId: string;
  workerId: string;
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
  skipped?: 'idempotent' | 'failfast-skip';
  wait?: { success: boolean; elapsedMs: number; type: string; error?: string };
}

type CachedBatchTaskResult = Omit<BatchTaskResult, 'skipped'>;

const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX = 256;
const idempotencyCaches = new Map<string, LruTtlCache<CachedBatchTaskResult>>();

function getConfigNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function recordBatchItemMetric(result: 'ok' | 'err' | 'skipped' | 'failfast-skip'): void {
  try {
    getMetricsCollector().inc('openchrome_batch_items_total', { result });
  } catch {
    // Best-effort metrics only.
  }
}

function recordIdempotencyEviction(reason: 'ttl' | 'lru'): void {
  try {
    getMetricsCollector().inc('openchrome_batch_idempotency_evictions_total', { reason });
  } catch {
    // Best-effort metrics only.
  }
}

function getIdempotencyCache(sessionId: string): LruTtlCache<CachedBatchTaskResult> {
  let cache = idempotencyCaches.get(sessionId);
  if (!cache) {
    cache = new LruTtlCache<CachedBatchTaskResult>({
      ttlMs: getConfigNumber('OPENCHROME_BATCH_IDEMPOTENCY_TTL_MS', DEFAULT_IDEMPOTENCY_TTL_MS),
      maxEntries: getConfigNumber('OPENCHROME_BATCH_IDEMPOTENCY_MAX', DEFAULT_IDEMPOTENCY_MAX),
      onEvict: recordIdempotencyEviction,
    });
    idempotencyCaches.set(sessionId, cache);
  }
  return cache;
}

export function clearBatchIdempotencyCachesForTests(): void {
  idempotencyCaches.clear();
}

/**
 * Simple concurrency limiter (no external dependency needed)
 */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) {
        const next = queue.shift()!;
        next();
      }
    }
  };
}

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<MCPResult> => {
  const tasks = args.tasks as BatchTask[];
  const concurrency = (args.concurrency as number) || 10;
  const failFast = (args.failFast as boolean) || false;

  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: tasks array is required and must not be empty' }],
      isError: true,
    };
  }

  const hasInterItemWait = tasks.some((task) => task.interItemWaitMs !== undefined || task.interItemWaitFor !== undefined);
  if (hasInterItemWait && concurrency !== 1) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          action: 'batch_execute',
          error: 'invalid_input',
          message: 'interItemWaitMs/interItemWaitFor require concurrency: 1',
        }),
      }],
      isError: true,
    };
  }

  const sessionManager = getSessionManager();
  const cdpClient = sessionManager.getCDPClient();
  const limiter = createLimiter(concurrency);
  const startTime = Date.now();
  const idempotencyCache = getIdempotencyCache(sessionId);
  let aborted = false;

  const throwIfDeadlineExceeded = (label: string): void => {
    if (context && getRemainingBudget(context) <= 0) {
      throw new OpenChromeTimeoutError(label, 0, false, true);
    }
  };

  const runInterItemDelay = async (delayMs: number): Promise<void> => {
    const boundedDelayMs = Math.max(0, delayMs);
    if (boundedDelayMs === 0) return;
    throwIfAborted(context);
    throwIfDeadlineExceeded('batch_execute inter-item wait');
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    await withTimeout(
      new Promise<void>((resolve) => {
        delayTimer = setTimeout(resolve, boundedDelayMs);
      }),
      boundedDelayMs + 1,
      'batch_execute inter-item wait',
      context,
    ).finally(() => {
      if (delayTimer) clearTimeout(delayTimer);
    });
    throwIfAborted(context);
    throwIfDeadlineExceeded('batch_execute inter-item wait');
  };

  const runWaitSpec = async (task: BatchTask, spec: WaitForSpec | undefined): Promise<BatchTaskResult['wait'] | undefined> => {
    if (!spec) return undefined;
    const waitStart = Date.now();
    const timeout = spec.timeout ?? 30000;
    try {
      throwIfAborted(context);
      throwIfDeadlineExceeded('batch_execute inter-item wait');
      const page = await sessionManager.getPage(sessionId, task.tabId, undefined, 'batch_execute.wait');
      if (!page) return { success: false, elapsedMs: Date.now() - waitStart, type: spec.type, error: `Tab ${task.tabId} not found` };
      throwIfAborted(context);
      throwIfDeadlineExceeded('batch_execute inter-item wait');
      const effectiveTimeoutMs = getEffectiveTimeoutMs(timeout, context);
      if (effectiveTimeoutMs <= 0) {
        throw new OpenChromeTimeoutError('batch_execute inter-item wait', 0, false, true);
      }

      switch (spec.type) {
        case 'selector':
          if (!spec.value) throw new Error('value is required for selector wait');
          await withTimeout(
            page.waitForSelector(spec.value, { timeout: effectiveTimeoutMs, visible: spec.visible ?? false }),
            timeout,
            'batch_execute selector wait',
            context,
          );
          break;
        case 'selector_hidden':
          if (!spec.value) throw new Error('value is required for selector_hidden wait');
          await withTimeout(
            page.waitForSelector(spec.value, { timeout: effectiveTimeoutMs, hidden: true }),
            timeout,
            'batch_execute selector_hidden wait',
            context,
          );
          break;
        case 'function':
          if (!spec.value) throw new Error('value is required for function wait');
          await withTimeout(
            page.waitForFunction(spec.value, {
              timeout: effectiveTimeoutMs,
              polling: Math.min(5000, Math.max(50, Math.floor(spec.pollIntervalMs ?? 200))),
            }),
            timeout,
            'batch_execute function wait',
            context,
          );
          break;
        case 'url_match':
          if (!spec.value) throw new Error('value is required for url_match wait');
          await withTimeout(
            page.waitForFunction((pattern: string) => {
              try { return new RegExp(pattern).test(window.location.href); } catch { return window.location.href.includes(pattern); }
            }, { timeout: effectiveTimeoutMs }, spec.value),
            timeout,
            'batch_execute url_match wait',
            context,
          );
          break;
        case 'navigation':
          await withTimeout(
            page.waitForNavigation({ timeout: effectiveTimeoutMs, waitUntil: 'domcontentloaded' }),
            timeout,
            'batch_execute navigation wait',
            context,
          );
          break;
        case 'timeout': {
          const delayMs = Math.min(60000, Math.max(0, parseInt(spec.value || String(timeout), 10)));
          await runInterItemDelay(delayMs);
          break;
        }
        default:
          throw new Error(`Unknown wait type ${(spec as { type?: string }).type}`);
      }
      throwIfAborted(context);
      throwIfDeadlineExceeded('batch_execute inter-item wait');
      return { success: true, elapsedMs: Date.now() - waitStart, type: spec.type };
    } catch (error) {
      return { success: false, elapsedMs: Date.now() - waitStart, type: spec.type, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const executeTask = async (task: BatchTask): Promise<BatchTaskResult> => {
    const taskStart = Date.now();
    const workerId = task.workerId || task.tabId;

    try {
      throwIfAborted(context);
      throwIfDeadlineExceeded('batch_execute');

      if (aborted) {
        const skipped: BatchTaskResult = {
          tabId: task.tabId,
          workerId,
          success: false,
          error: 'Aborted due to failFast',
          durationMs: 0,
          skipped: 'failfast-skip',
        };
        recordBatchItemMetric('failfast-skip');
        return skipped;
      }

      if (task.idempotencyKey) {
        const cached = idempotencyCache.get(task.idempotencyKey);
        if (cached?.success) {
          recordBatchItemMetric('skipped');
          return { ...cached, skipped: 'idempotent' };
        }
      }

      const page = await sessionManager.getPage(sessionId, task.tabId, undefined, 'batch_execute');
      if (!page) {
        const failed: BatchTaskResult = {
          tabId: task.tabId,
          workerId,
          success: false,
          error: `Tab ${task.tabId} not found`,
          durationMs: Date.now() - taskStart,
        };
        recordBatchItemMetric('err');
        return failed;
      }

      const timeout = normalizeJavascriptTimeoutMs(task.timeout);
      const commandTimeoutMs = addTimeoutResponseGraceMs(timeout);
      const effectiveTimeoutMs = getEffectiveTimeoutMs(commandTimeoutMs, context);
      if (effectiveTimeoutMs <= 0) {
        throw new OpenChromeTimeoutError('batch_execute', 0, false, true);
      }
      throwIfAborted(context);
      const invocationDeadlineAt = getTimeoutDeadlineAt(commandTimeoutMs, context);
      const sendOptions: JavascriptCDPSendOptions = {
        timeoutMs: commandTimeoutMs,
        deadlineAt: invocationDeadlineAt,
        signal: context?.signal,
        reserveRuntimeEvaluateResponseGrace: true,
      };

      // Execute via CDP Runtime.evaluate with full await support
      const cdpResult = await withTimeout(
        cdpClient.send<CDPEvalResult>(page, 'Runtime.evaluate', {
          expression: task.script,
          returnByValue: false,
          awaitPromise: true,
          userGesture: true,
          timeout,
        }, sendOptions),
        commandTimeoutMs,
        'batch_execute',
        context,
      );

      if (cdpResult.exceptionDetails) {
        const errorMsg =
          cdpResult.exceptionDetails.exception?.description ||
          cdpResult.exceptionDetails.text ||
          'Unknown error';
        if (failFast) aborted = true;
        const failed: BatchTaskResult = {
          tabId: task.tabId,
          workerId,
          success: false,
          error: errorMsg,
          durationMs: Date.now() - taskStart,
        };
        recordBatchItemMetric('err');
        return failed;
      }

      // Format result value using shared formatter (same as javascript_tool)
      const formattingTimeoutMs = getRemainingTimeoutMs(invocationDeadlineAt);
      if (formattingTimeoutMs <= 0) {
        throw new OpenChromeTimeoutError('batch_execute Promise resolution', 0, false, true);
      }
      const resultValue = await withTimeout(
        formatCDPResult(cdpResult.result, cdpClient, page, 0, sendOptions),
        formattingTimeoutMs,
        'batch_execute Promise resolution',
        context,
      );

      // Parse JSON result back if possible
      let data: unknown = resultValue;
      try {
        data = JSON.parse(resultValue);
      } catch {
        data = resultValue;
      }

      const succeeded: BatchTaskResult = {
        tabId: task.tabId,
        workerId,
        success: true,
        data,
        durationMs: Date.now() - taskStart,
      };
      if (task.idempotencyKey) idempotencyCache.set(task.idempotencyKey, succeeded);
      recordBatchItemMetric('ok');
      return succeeded;
    } catch (error) {
      if (failFast) aborted = true;
      const failed: BatchTaskResult = {
        tabId: task.tabId,
        workerId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - taskStart,
      };
      recordBatchItemMetric('err');
      return failed;
    }
  };

  // Execute all tasks with concurrency control. Inter-item waits require sequential mode
  // so the wait happens after an item before the next sibling starts.
  const results: BatchTaskResult[] = [];
  if (concurrency === 1) {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const result = await executeTask(task);
      if (i < tasks.length - 1 && !result.skipped && !context?.signal?.aborted) {
        try {
          if (typeof task.interItemWaitMs === 'number') {
            await runInterItemDelay(task.interItemWaitMs);
          }
        } catch (error) {
          result.success = false;
          result.error = `inter-item wait failed: ${error instanceof Error ? error.message : String(error)}`;
          recordBatchItemMetric('err');
          results.push(result);
          break;
        }
        const wait = await runWaitSpec(task, task.interItemWaitFor);
        if (wait) {
          result.wait = wait;
          if (!wait.success) {
            result.success = false;
            result.error = `interItemWaitFor failed: ${wait.error ?? wait.type}`;
            recordBatchItemMetric('err');
            results.push(result);
            break;
          }
        }
      }
      results.push(result);
    }
  } else {
    results.push(...await Promise.all(tasks.map((task) => limiter(() => executeTask(task)))));
  }

  const wallClockMs = Date.now() - startTime;
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  const output = {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed,
      totalDurationMs,
      wallClockDurationMs: wallClockMs,
      concurrency,
    },
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
  };
};

export function registerBatchExecuteTool(server: MCPServer): void {
  server.registerTool('batch_execute', handler, definition);
}
