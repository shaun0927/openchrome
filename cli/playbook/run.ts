/**
 * Playbook runner — executes a parsed+substituted playbook against the MCP server.
 *
 * Sequential, fail-fast execution. On step failure all subsequent steps
 * are marked 'skipped'. Returns a structured RunResult.
 */

import type { Playbook, Step } from './parse';
import { expandStep } from './expand';
import { substituteValue } from './vars';
import { StdioMcpClient, TransportError } from './stdio-client';

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface StepResult {
  index: number;
  verb: string;
  tool: string;
  args: Record<string, unknown>;
  status: StepStatus;
  durationMs: number;
  result?: unknown;
  error?: string;
}

export interface RunSummary {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface RunResult {
  name: string | undefined;
  steps: StepResult[];
  summary: RunSummary;
}

export interface RunOptions {
  reuse: boolean;
  /** Pre-built var map (merged playbook vars + CLI vars). */
  varMap: Record<string, string>;
  /** Optional injectable client for testing. */
  client?: Pick<StdioMcpClient, 'connect' | 'callTool' | 'disconnect'>;
}

export async function runPlaybook(playbook: Playbook, options: RunOptions): Promise<RunResult> {
  const client = options.client ?? new StdioMcpClient();

  try {
    await client.connect(options.reuse);
  } catch (err) {
    throw new TransportError(
      `Failed to connect to MCP server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const stepResults: StepResult[] = [];
  let failed = false;

  try {
    for (let i = 0; i < playbook.steps.length; i++) {
      const step: Step = playbook.steps[i];

      if (failed) {
        stepResults.push({
          index: i,
          verb: step.verb,
          tool: '',
          args: {},
          status: 'skipped',
          durationMs: 0,
        });
        continue;
      }

      // Substitute vars in args
      const substitutedArgs = substituteValue(step.args, options.varMap, i) as Record<string, unknown>;

      // Expand to MCP tool call
      const expanded = expandStep(step.verb, substitutedArgs);

      const start = Date.now();
      let status: StepStatus = 'ok';
      let result: unknown;
      let error: string | undefined;

      try {
        const callResult = await client.callTool(expanded.tool, expanded.callArgs);
        result = callResult.result;
        if (!callResult.success) {
          status = 'failed';
          failed = true;
          error = `Step ${i} (${step.verb}): tool call returned failure`;
          if (callResult.verdict) {
            error = `Step ${i} (${step.verb}): assert verdict="${callResult.verdict}"`;
          }
        }
      } catch (err) {
        // P1 codex fix: distinguish transport-class failures from step/assertion
        // failures. TransportError indicates the MCP client could not deliver
        // the call (timeout, broken pipe, child exit). These must surface as
        // exit code 3 in the CLI, not exit code 1 (test/assert failure), so we
        // re-throw and let the CLI's outer handler map TransportError -> 3.
        // Note: stepResults so far are intentionally discarded — the run is
        // aborted at the transport boundary, not reported as a failed scenario.
        if (err instanceof TransportError) {
          throw err;
        }
        status = 'failed';
        failed = true;
        error = `Step ${i} (${step.verb}): ${err instanceof Error ? err.message : String(err)}`;
      }

      stepResults.push({
        index: i,
        verb: step.verb,
        tool: expanded.tool,
        args: expanded.callArgs,
        status,
        durationMs: Date.now() - start,
        result,
        error,
      });
    }
  } finally {
    await client.disconnect();
  }

  const passed = stepResults.filter((s) => s.status === 'ok').length;
  const failedCount = stepResults.filter((s) => s.status === 'failed').length;
  const skipped = stepResults.filter((s) => s.status === 'skipped').length;

  return {
    name: playbook.name,
    steps: stepResults,
    summary: {
      ok: failedCount === 0 && skipped === 0,
      total: playbook.steps.length,
      passed,
      failed: failedCount,
      skipped,
    },
  };
}
