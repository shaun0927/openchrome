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
  PlanStepExecutionRecord,
} from '../types/plan-cache';
import * as crypto from 'node:crypto';
import { withTimeout } from '../utils/with-timeout';

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


function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function computeKnownGoodPrefix(ledger: PlanStepExecutionRecord[]): number {
  let prefix = 0;
  for (const entry of ledger.filter((step) => step.phase === 'main').sort((a, b) => a.order - b.order)) {
    if (entry.order !== prefix + 1 || entry.status !== 'success') break;
    prefix = entry.order;
  }
  return prefix;
}

function withLedger(
  result: Omit<PlanExecutionResult, 'ledger'>,
  ledger: PlanStepExecutionRecord[],
  frontierStepOrder?: number,
  invalidationReason?: string,
): PlanExecutionResult {
  return {
    ...result,
    ledger: {
      steps: ledger,
      knownGoodPrefixLength: computeKnownGoodPrefix(ledger),
      ...(frontierStepOrder !== undefined && { frontierStepOrder }),
      ...(invalidationReason && { invalidationReason }),
    },
  };
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
    const ledger: PlanStepExecutionRecord[] = [];

    // 1. Build params map: plan defaults first, runtime overrides on top
    const params: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(plan.parameters)) {
      if (spec.default !== undefined) {
        params[key] = spec.default;
      }
    }
    Object.assign(params, runtimeParams);

    const failure = (error: string, frontierStepOrder?: number): PlanExecutionResult => withLedger({
      success: false,
      planId: plan.id,
      error,
      durationMs: Date.now() - startTime,
      stepsExecuted,
      totalSteps: plan.steps.length,
    }, ledger, frontierStepOrder, error);

    // 2. Execute each step sequentially
    for (const step of plan.steps) {
      const stepLabel = `plan=${plan.id} step=${step.order} tool=${step.tool}`;

      // a. Resolve handler
      const handler = this.toolResolver(step.tool);
      if (!handler) {
        const msg = `No handler found for tool "${step.tool}" at ${stepLabel}`;
        console.error(`[PlanExecutor] ${msg}`);
        ledger.push({ order: step.order, tool: step.tool, argsHash: stableHash(step.args), phase: 'main', status: 'failed', durationMs: 0, reason: msg });
        return failure(msg, step.order);
      }

      // b. Substitute template variables in args
      const substitutedArgs = substituteParams(step.args, params) as Record<string, unknown>;
      const stepStartedAt = Date.now();
      const argsHash = stableHash(substitutedArgs);

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
        ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'main', status: 'failed', durationMs: Date.now() - stepStartedAt, reason: errMsg });

        // Check for a matching error handler
        const conditionKey = `step${step.order}_error`;
        const recovered = await this.tryRecovery(
          conditionKey,
          plan.errorHandlers,
          sessionId,
          params,
          stepsExecuted,
          ledger
        );
        if (recovered !== null) {
          stepsExecuted = recovered.stepsExecuted;
          // Merge any params updates from recovery into our params
          Object.assign(params, recovered.params);
          continue;
        }

        return failure(`Step ${step.order} (${step.tool}) failed: ${errMsg}`, step.order);
      }

      // d. Check for error result
      if (mcpResult.isError) {
        const errMsg = mcpResult.content?.[0]?.text ?? 'Unknown tool error';
        console.error(`[PlanExecutor] Tool returned error at ${stepLabel}: ${errMsg}`);
        ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'main', status: 'failed', durationMs: Date.now() - stepStartedAt, reason: errMsg });

        const conditionKey = `step${step.order}_error`;
        const recovered = await this.tryRecovery(
          conditionKey,
          plan.errorHandlers,
          sessionId,
          params,
          stepsExecuted,
          ledger
        );
        if (recovered !== null) {
          stepsExecuted = recovered.stepsExecuted;
          Object.assign(params, recovered.params);
          continue;
        }

        return failure(`Step ${step.order} (${step.tool}) returned error: ${errMsg}`, step.order);
      }

      // e. Check for empty result (before storing) — may trigger empty_result handler
      if (isEmptyResult(mcpResult)) {
        ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'main', status: 'empty_result', durationMs: Date.now() - stepStartedAt, reason: 'empty result' });
        const conditionKey = `step${step.order}_empty_result`;
        const recovered = await this.tryRecovery(
          conditionKey,
          plan.errorHandlers,
          sessionId,
          params,
          stepsExecuted,
          ledger
        );
        if (recovered !== null) {
          stepsExecuted = recovered.stepsExecuted;
          Object.assign(params, recovered.params);
          continue;
        }
        // No handler for empty — treat as non-fatal, just skip storing
      }

      // f. Parse and store result if requested
      let storedAs: string | undefined;
      if (step.parseResult && step.parseResult.storeAs) {
        try {
          const extracted = extractResult(mcpResult, step.parseResult);
          params[step.parseResult.storeAs] = extracted;
          storedAs = step.parseResult.storeAs;
        } catch (err) {
          console.error(
            `[PlanExecutor] Failed to extract result at ${stepLabel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          // Non-fatal: continue without storing
        }
      }
      if (!isEmptyResult(mcpResult)) {
        ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'main', status: 'success', durationMs: Date.now() - stepStartedAt, storedAs });
      }
    }

    // 3. Validate success criteria
    const criteriaError = validateSuccessCriteria(plan.successCriteria, params);
    if (criteriaError) {
      console.error(`[PlanExecutor] Success criteria failed for plan=${plan.id}: ${criteriaError}`);
      return withLedger({
        success: false,
        planId: plan.id,
        error: `Success criteria not met: ${criteriaError}`,
        durationMs: Date.now() - startTime,
        stepsExecuted,
        totalSteps: plan.steps.length,
      }, ledger, computeKnownGoodPrefix(ledger) + 1, `Success criteria not met: ${criteriaError}`);
    }

    // 4. Return success with all collected params as data
    return withLedger({
      success: true,
      planId: plan.id,
      data: params,
      durationMs: Date.now() - startTime,
      stepsExecuted,
      totalSteps: plan.steps.length,
    }, ledger);
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
    currentStepsExecuted: number,
    ledger: PlanStepExecutionRecord[]
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
      const recoveryStartedAt = Date.now();
      const argsHash = stableHash(substitutedArgs);

      let mcpResult: MCPResult;
      try {
        mcpResult = await withTimeout(
          toolHandler(sessionId, substitutedArgs),
          step.timeout,
          stepLabel
        );
        stepsExecuted++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[PlanExecutor] Recovery step failed at ${stepLabel}: ${errMsg}`
        );
        ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'recovery', recoveryCondition: conditionKey, status: 'failed', durationMs: Date.now() - recoveryStartedAt, reason: errMsg });
        continue;
      }

      if (mcpResult.isError) {
        const errMsg = mcpResult.content?.[0]?.text ?? 'unknown';
        console.error(
          `[PlanExecutor] Recovery step returned error at ${stepLabel}: ${errMsg}`
        );
        ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'recovery', recoveryCondition: conditionKey, status: 'failed', durationMs: Date.now() - recoveryStartedAt, reason: errMsg });
        continue;
      }

      let storedAs: string | undefined;
      if (step.parseResult && step.parseResult.storeAs) {
        try {
          const extracted = extractResult(mcpResult, step.parseResult);
          params[step.parseResult.storeAs] = extracted;
          storedAs = step.parseResult.storeAs;
        } catch (err) {
          console.error(
            `[PlanExecutor] Recovery: failed to extract result at ${stepLabel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      ledger.push({ order: step.order, tool: step.tool, argsHash, phase: 'recovery', recoveryCondition: conditionKey, status: isEmptyResult(mcpResult) ? 'empty_result' : 'success', durationMs: Date.now() - recoveryStartedAt, storedAs });
    }

    return { stepsExecuted, params };
  }
}
