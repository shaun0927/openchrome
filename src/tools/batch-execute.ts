/**
 * Batch Execute Tool - Execute JavaScript across multiple tabs in parallel
 *
 * Eliminates agent spawn overhead by running scripts directly via CDP,
 * bypassing the need for individual Claude agent instances per tab.
 *
 * Performance impact: Reduces Phase 2 (agent spawn) from ~109s to ~0s
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';

const definition: MCPToolDefinition = {
  name: 'batch_execute',
  description: 'Execute JavaScript across multiple tabs in parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'Array of tasks to execute in parallel',
        items: {
          type: 'object',
          properties: {
            tabId: {
              type: 'string',
              description: 'Tab ID to execute the script in',
            },
            workerId: {
              type: 'string',
              description: 'Worker ID for result identification',
            },
            script: {
              type: 'string',
              description: 'JS code to execute. Promises auto-awaited.',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in ms. Default: 30000',
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
};

interface BatchTask {
  tabId: string;
  workerId?: string;
  script: string;
  timeout?: number;
}

interface BatchTaskResult {
  tabId: string;
  workerId: string;
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
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
  args: Record<string, unknown>
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

  const sessionManager = getSessionManager();
  const cdpClient = sessionManager.getCDPClient();
  const limiter = createLimiter(concurrency);
  const startTime = Date.now();
  let aborted = false;

  const executeTask = async (task: BatchTask): Promise<BatchTaskResult> => {
    const taskStart = Date.now();
    const workerId = task.workerId || task.tabId;

    if (aborted) {
      return {
        tabId: task.tabId,
        workerId,
        success: false,
        error: 'Aborted due to failFast',
        durationMs: 0,
      };
    }

    try {
      const page = await sessionManager.getPage(sessionId, task.tabId, undefined, 'batch_execute');
      if (!page) {
        return {
          tabId: task.tabId,
          workerId,
          success: false,
          error: `Tab ${task.tabId} not found`,
          durationMs: Date.now() - taskStart,
        };
      }

      const timeout = task.timeout || 30000;

      // Execute via CDP Runtime.evaluate with full await support
      let tid: ReturnType<typeof setTimeout>;
      const cdpResult = await Promise.race([
        cdpClient.send<{
          result: {
            type: string;
            subtype?: string;
            value?: unknown;
            description?: string;
            className?: string;
          };
          exceptionDetails?: {
            text: string;
            exception?: { description?: string };
          };
        }>(page, 'Runtime.evaluate', {
          expression: task.script,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        }).finally(() => clearTimeout(tid)),
        new Promise<never>((_, reject) => {
          tid = setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout);
        }),
      ]);

      if (cdpResult.exceptionDetails) {
        const errorMsg =
          cdpResult.exceptionDetails.exception?.description ||
          cdpResult.exceptionDetails.text ||
          'Unknown error';
        if (failFast) aborted = true;
        return {
          tabId: task.tabId,
          workerId,
          success: false,
          error: errorMsg,
          durationMs: Date.now() - taskStart,
        };
      }

      // Format result value
      const evalResult = cdpResult.result;
      let resultValue: string;
      if (evalResult.type === 'undefined') {
        resultValue = 'undefined';
      } else if (evalResult.value !== undefined) {
        if (typeof evalResult.value === 'object') {
          resultValue = JSON.stringify(evalResult.value, null, 2);
        } else {
          resultValue = String(evalResult.value);
        }
      } else if (evalResult.description) {
        resultValue = evalResult.description;
      } else {
        resultValue = `[${evalResult.type}]`;
      }

      // Parse JSON result back if possible
      let data: unknown = resultValue;
      try {
        data = JSON.parse(resultValue);
      } catch {
        data = resultValue;
      }

      return {
        tabId: task.tabId,
        workerId,
        success: true,
        data,
        durationMs: Date.now() - taskStart,
      };
    } catch (error) {
      if (failFast) aborted = true;
      return {
        tabId: task.tabId,
        workerId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - taskStart,
      };
    }
  };

  // Execute all tasks with concurrency control
  const results = await Promise.all(
    tasks.map((task) => limiter(() => executeTask(task)))
  );

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
