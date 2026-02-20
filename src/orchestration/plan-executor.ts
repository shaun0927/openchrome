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
  PlanExecutionResult,
} from '../types/plan-cache';

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
 * Apply a timeout to a promise via Promise.race.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms (${label})`)), timeoutMs)
    ),
  ]);
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
    runtimeParams: Record<string, unknown>
  ): Promise<PlanExecutionResult> {
    const startTime = Date.now();
    let stepsExecuted = 0;

    // 1. Build params map: plan defaults first, runtime overrides on top
    const params: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(plan.parameters)) {
      if (spec.default !== undefined) {
        params[key] = spec.default;
      }
    }
    Object.assign(params, runtimeParams);

    const failure = (error: string): PlanExecutionResult => ({
      success: false,
      planId: plan.id,
      error,
      durationMs: Date.now() - startTime,
      stepsExecuted,
      totalSteps: plan.steps.length,
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
      };
    }

    // 4. Return success with all collected params as data
    return {
      success: true,
      planId: plan.id,
      data: params,
      durationMs: Date.now() - startTime,
      stepsExecuted,
      totalSteps: plan.steps.length,
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
