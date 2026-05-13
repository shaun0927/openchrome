/**
 * PlanExecutor - Executes compiled plans by chaining tool handlers internally.
 *
 * Bypasses per-step agent LLM round-trips by resolving and calling tool handlers
 * directly from the MCP server's internal registry.
 */

import { MCPResult, ToolHandler } from '../types/mcp';
import {
  CompiledPlan,
  CompiledStep,
  PlanErrorHandler,
  PlanExecutionOptions,
  PlanExecutionResult,
  PlanFinalVerificationResult,
} from '../types/plan-cache';
import { evaluate } from '../contracts/evaluate';
import type { EvalContext, NetworkLogEntry } from '../contracts/eval-context';
import { evaluateTaskSignature, preflightAllowedTools } from '../contracts/task-signature';
import type { TaskSignatureToolCallSummary } from '../contracts/task-signature';
import { withTimeout } from '../utils/with-timeout';

interface SnapshotInput {
  url?: string;
  dom_text?: string | null | Record<string, string | null>;
  dom_count?: Record<string, number>;
  network?: NetworkLogEntry[];
  screenshot_png_base64?: string;
  has_open_dialog?: boolean;
  captured_at?: number;
  timestamp?: number;
}

function buildSnapshotEvalContext(snapshot: SnapshotInput): EvalContext {
  const domTextBySelector = typeof snapshot.dom_text === 'object' && snapshot.dom_text !== null
    ? snapshot.dom_text as Record<string, string | null>
    : undefined;
  const bodyText = typeof snapshot.dom_text === 'string' || snapshot.dom_text === null
    ? snapshot.dom_text
    : undefined;
  const screenshot = snapshot.screenshot_png_base64 ? Buffer.from(snapshot.screenshot_png_base64, 'base64') : null;
  return {
    async url() { return snapshot.url ?? ''; },
    async domText(selector) {
      if (domTextBySelector) return domTextBySelector[selector ?? 'body'] ?? domTextBySelector.body ?? null;
      return bodyText ?? null;
    },
    async domCount(selector) { return snapshot.dom_count?.[selector] ?? 0; },
    async networkSince() { return snapshot.network ?? []; },
    async screenshotPng() { return screenshot; },
    async hasOpenDialog() { return snapshot.has_open_dialog ?? false; },
  };
}

function isSnapshotInput(value: unknown): value is SnapshotInput {
  return typeof value === 'object' && value !== null;
}

async function runFinalVerification(
  plan: CompiledPlan,
  params: Record<string, unknown>,
): Promise<PlanFinalVerificationResult | null> {
  const gate = plan.finalVerification;
  if (!gate) return null;
  const snapshotParam = gate.snapshotParam || 'finalSnapshot';
  const snapshot = params[snapshotParam];
  if (!isSnapshotInput(snapshot)) {
    return {
      passed: false,
      snapshotParam,
      assertions: [],
      error: `final verification snapshot param missing or invalid: ${snapshotParam}`,
    };
  }

  const capturedAt = typeof snapshot.captured_at === 'number'
    ? snapshot.captured_at
    : typeof snapshot.timestamp === 'number'
      ? snapshot.timestamp
      : undefined;
  if (gate.freshnessMs !== undefined && capturedAt !== undefined && Date.now() - capturedAt > gate.freshnessMs) {
    return {
      passed: false,
      snapshotParam,
      assertions: [],
      error: `final verification snapshot is stale: age ${Date.now() - capturedAt}ms exceeds ${gate.freshnessMs}ms`,
    };
  }

  const unsupportedEvidence = (gate.requiredEvidence || []).filter(kind => !['dom', 'url', 'network', 'screenshot'].includes(kind));
  if (unsupportedEvidence.length > 0) {
    return {
      passed: false,
      snapshotParam,
      assertions: [],
      error: `unsupported finalVerification.requiredEvidence: ${unsupportedEvidence.join(', ')}`,
    };
  }

  const assertions: PlanFinalVerificationResult['assertions'] = [];
  const ctx = buildSnapshotEvalContext(snapshot);
  for (let i = 0; i < gate.finalAssertions.length; i++) {
    const assertion = gate.finalAssertions[i];
    const result = await evaluate(assertion, ctx);
    assertions.push({ index: i, passed: result.passed, evidence: result.evidence });
    if (!result.passed) {
      return {
        passed: false,
        snapshotParam,
        assertions,
        failedAssertion: { index: i, assertion, evidence: result.evidence },
      };
    }
  }
  return { passed: true, snapshotParam, assertions };
}

/**
 * Recursively substitute ${varName} templates in a value using the params map.
 * Handles strings, objects, and arrays. Non-string primitives are returned as-is.
 * Missing vars are left as-is (no crash).
 */
function substituteParams(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const resolved = params[varName];
      if (resolved === undefined) return match;
      if (typeof resolved === 'string') return resolved;
      return JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteParams(item, params));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteParams(v, params);
    }
    return result;
  }
  return value;
}


/**
 * Extract result data from an MCPResult according to parseResult spec.
 * Returns the extracted value (raw text, parsed JSON, or a specific field).
 */
function extractResult(
  mcpResult: MCPResult,
  parseResult: NonNullable<CompiledStep['parseResult']>
): unknown {
  const content = mcpResult.content;
  const text = content && content.length > 0 ? content[0].text ?? '' : '';

  if (parseResult.format === 'text') {
    return text;
  }

  // format === 'json'
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (parseResult.extractField) {
    const obj = parsed as Record<string, unknown>;
    parsed = obj?.[parseResult.extractField];
  }

  return parsed;
}

/**
 * Check whether an MCPResult represents an empty/no-data result.
 */
function isEmptyResult(mcpResult: MCPResult): boolean {
  if (mcpResult.isError) return false; // errors are not "empty"
  const content = mcpResult.content;
  if (!content || content.length === 0) return true;
  const text = content[0].text ?? '';
  if (text.trim() === '' || text.trim() === 'null' || text.trim() === '[]' || text.trim() === '{}') {
    return true;
  }
  return false;
}

/**
 * Validate final params against the plan's success criteria.
 * Returns null if valid, or an error string describing the violation.
 */
function validateSuccessCriteria(
  criteria: CompiledPlan['successCriteria'],
  params: Record<string, unknown>
): string | null {
  if (criteria.minDataItems !== undefined) {
    // Find the first array or object in params that could represent "data items"
    let found = false;
    for (const val of Object.values(params)) {
      if (Array.isArray(val)) {
        if (val.length < criteria.minDataItems) {
          return `minDataItems requirement not met: got ${val.length}, need ${criteria.minDataItems}`;
        }
        found = true;
        break;
      } else if (val !== null && typeof val === 'object') {
        const count = Object.keys(val as object).length;
        if (count < criteria.minDataItems) {
          return `minDataItems requirement not met: got ${count}, need ${criteria.minDataItems}`;
        }
        found = true;
        break;
      }
    }
    if (!found && criteria.minDataItems > 0) {
      return `minDataItems requirement not met: no collection found in params`;
    }
  }

  if (criteria.requiredFields && criteria.requiredFields.length > 0) {
    for (const field of criteria.requiredFields) {
      if (!(field in params) || params[field] === undefined) {
        return `Required field missing from params: ${field}`;
      }
    }
  }

  return null;
}

export class PlanExecutor {
  private toolResolver: (toolName: string) => ToolHandler | null;

  constructor(toolResolver: (toolName: string) => ToolHandler | null) {
    this.toolResolver = toolResolver;
  }

  async execute(
    plan: CompiledPlan,
    sessionId: string,
    runtimeParams: Record<string, unknown>,
    options: PlanExecutionOptions = {}
  ): Promise<PlanExecutionResult> {
    const startTime = Date.now();
    let stepsExecuted = 0;
    const recentTools: TaskSignatureToolCallSummary[] = [];

    if (options.taskSignature) {
      const preflight = preflightAllowedTools(
        options.taskSignature,
        [
          ...plan.steps.map((step) => step.tool),
          ...plan.errorHandlers.flatMap((handler) =>
            handler.steps.map((recoveryStep) => recoveryStep.tool),
          ),
        ],
      );
      if (preflight) {
        return {
          success: false,
          planId: plan.id,
          error: preflight.reasons.join('; '),
          durationMs: Date.now() - startTime,
          stepsExecuted,
          totalSteps: plan.steps.length,
          taskSignature: preflight,
        };
      }
    }

    // 1. Build params map: plan defaults first, runtime overrides on top
    const params: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(plan.parameters)) {
      if (spec.default !== undefined) {
        params[key] = spec.default;
      }
    }
    Object.assign(params, runtimeParams);

    const failure = (error: string, taskSignature?: PlanExecutionResult['taskSignature']): PlanExecutionResult => ({
      success: false,
      planId: plan.id,
      error,
      durationMs: Date.now() - startTime,
      stepsExecuted,
      totalSteps: plan.steps.length,
      ...(taskSignature ? { taskSignature } : {}),
    });

    // 2. Execute each step sequentially
    for (const step of plan.steps) {
      const stepLabel = `plan=${plan.id} step=${step.order} tool=${step.tool}`;

      // a. Resolve handler
      const handler = this.toolResolver(step.tool);
      if (!handler) {
        const msg = `No handler found for tool "${step.tool}" at ${stepLabel}`;
        console.error(`[PlanExecutor] ${msg}`);
        return failure(msg);
      }

      // b. Substitute template variables in args
      const substitutedArgs = substituteParams(step.args, params) as Record<string, unknown>;

      // c. Call handler with timeout
      let mcpResult: MCPResult;
      try {
        mcpResult = await withTimeout(
          handler(sessionId, substitutedArgs),
          step.timeout,
          stepLabel
        );
        stepsExecuted++;
        recentTools.push({ tool: step.tool, progressed: !isEmptyResult(mcpResult) && !mcpResult.isError });
        if (options.taskSignature) {
          const taskStatus = await evaluateTaskSignature({
            signature: options.taskSignature,
            recentTools,
            elapsedMs: Date.now() - startTime,
            toolCount: stepsExecuted,
          });
          if (taskStatus.status === 'success') {
            return {
              success: true,
              planId: plan.id,
              data: params,
              durationMs: Date.now() - startTime,
              stepsExecuted,
              totalSteps: plan.steps.length,
              taskSignature: taskStatus,
            };
          }
          if (taskStatus.status !== 'continue') {
            return failure(`task signature ${taskStatus.status}: ${taskStatus.reasons.join('; ')}`, taskStatus);
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[PlanExecutor] Step failed at ${stepLabel}: ${errMsg}`);

        // Check for a matching error handler
        const conditionKey = `step${step.order}_error`;
        const recovered = await this.tryRecovery(
          conditionKey,
          plan.errorHandlers,
          sessionId,
          params,
          stepsExecuted
        );
        if (recovered !== null) {
          stepsExecuted = recovered.stepsExecuted;
          // Merge any params updates from recovery into our params
          Object.assign(params, recovered.params);
          continue;
        }

        return failure(`Step ${step.order} (${step.tool}) failed: ${errMsg}`);
      }

      // d. Check for error result
      if (mcpResult.isError) {
        const errMsg = mcpResult.content?.[0]?.text ?? 'Unknown tool error';
        console.error(`[PlanExecutor] Tool returned error at ${stepLabel}: ${errMsg}`);

        const conditionKey = `step${step.order}_error`;
        const recovered = await this.tryRecovery(
          conditionKey,
          plan.errorHandlers,
          sessionId,
          params,
          stepsExecuted
        );
        if (recovered !== null) {
          stepsExecuted = recovered.stepsExecuted;
          Object.assign(params, recovered.params);
          continue;
        }

        return failure(`Step ${step.order} (${step.tool}) returned error: ${errMsg}`);
      }

      // e. Check for empty result (before storing) — may trigger empty_result handler
      if (isEmptyResult(mcpResult)) {
        const conditionKey = `step${step.order}_empty_result`;
        const recovered = await this.tryRecovery(
          conditionKey,
          plan.errorHandlers,
          sessionId,
          params,
          stepsExecuted
        );
        if (recovered !== null) {
          stepsExecuted = recovered.stepsExecuted;
          Object.assign(params, recovered.params);
          continue;
        }
        // No handler for empty — treat as non-fatal, just skip storing
      }

      // f. Parse and store result if requested
      if (step.parseResult && step.parseResult.storeAs) {
        try {
          const extracted = extractResult(mcpResult, step.parseResult);
          params[step.parseResult.storeAs] = extracted;
        } catch (err) {
          console.error(
            `[PlanExecutor] Failed to extract result at ${stepLabel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          // Non-fatal: continue without storing
        }
      }
    }

    // 3. Validate success criteria
    const criteriaError = validateSuccessCriteria(plan.successCriteria, params);
    if (criteriaError) {
      console.error(`[PlanExecutor] Success criteria failed for plan=${plan.id}: ${criteriaError}`);
      return {
        success: false,
        planId: plan.id,
        error: `Success criteria not met: ${criteriaError}`,
        durationMs: Date.now() - startTime,
        stepsExecuted,
        totalSteps: plan.steps.length,
        ...(options.taskSignature
          ? { taskSignature: await evaluateTaskSignature({
              signature: options.taskSignature,
              recentTools,
              elapsedMs: Date.now() - startTime,
              toolCount: stepsExecuted,
            }) }
          : {}),
      };
    }

    // 4. Optional final Outcome Contract verification gate
    const finalVerification = await runFinalVerification(plan, params);
    if (finalVerification && !finalVerification.passed) {
      return {
        success: false,
        planId: plan.id,
        error: finalVerification.error || `Final verification failed at assertion ${finalVerification.failedAssertion?.index ?? 'unknown'}`,
        durationMs: Date.now() - startTime,
        stepsExecuted,
        totalSteps: plan.steps.length,
        finalVerification,
        ...(options.taskSignature
          ? { taskSignature: await evaluateTaskSignature({
              signature: options.taskSignature,
              recentTools,
              elapsedMs: Date.now() - startTime,
              toolCount: stepsExecuted,
            }) }
          : {}),
      };
    }

    // 5. Return success with all collected params as data
    return {
      success: true,
      planId: plan.id,
      data: params,
      durationMs: Date.now() - startTime,
      stepsExecuted,
      totalSteps: plan.steps.length,
      ...(finalVerification ? { finalVerification } : {}),
      ...(options.taskSignature
        ? { taskSignature: await evaluateTaskSignature({
            signature: options.taskSignature,
            recentTools,
            elapsedMs: Date.now() - startTime,
            toolCount: stepsExecuted,
          }) }
        : {}),
    };
  }

  /**
   * Attempt to find and run a recovery handler for a given condition.
   * Returns updated stepsExecuted + params snapshot on success, null if no handler.
   */
  private async tryRecovery(
    conditionKey: string,
    errorHandlers: PlanErrorHandler[],
    sessionId: string,
    params: Record<string, unknown>,
    currentStepsExecuted: number
  ): Promise<{ stepsExecuted: number; params: Record<string, unknown> } | null> {
    const handler = errorHandlers.find((h) => h.condition === conditionKey);
    if (!handler) return null;

    console.error(
      `[PlanExecutor] Running error handler "${handler.action}" for condition "${conditionKey}"`
    );

    let stepsExecuted = currentStepsExecuted;

    for (const step of handler.steps) {
      const stepLabel = `recovery action=${handler.action} step=${step.order} tool=${step.tool}`;
      const toolHandler = this.toolResolver(step.tool);

      if (!toolHandler) {
        console.error(`[PlanExecutor] Recovery: no handler for tool "${step.tool}" at ${stepLabel}`);
        continue;
      }

      const substitutedArgs = substituteParams(step.args, params) as Record<string, unknown>;

      let mcpResult: MCPResult;
      try {
        mcpResult = await withTimeout(
          toolHandler(sessionId, substitutedArgs),
          step.timeout,
          stepLabel
        );
        stepsExecuted++;
      } catch (err) {
        console.error(
          `[PlanExecutor] Recovery step failed at ${stepLabel}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        continue;
      }

      if (mcpResult.isError) {
        console.error(
          `[PlanExecutor] Recovery step returned error at ${stepLabel}: ${
            mcpResult.content?.[0]?.text ?? 'unknown'
          }`
        );
        continue;
      }

      if (step.parseResult && step.parseResult.storeAs) {
        try {
          const extracted = extractResult(mcpResult, step.parseResult);
          params[step.parseResult.storeAs] = extracted;
        } catch (err) {
          console.error(
            `[PlanExecutor] Recovery: failed to extract result at ${stepLabel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    return { stepsExecuted, params };
  }
}
