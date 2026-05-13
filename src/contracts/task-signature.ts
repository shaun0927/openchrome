import type { Assertion, EvaluationResult } from './types';
import { validateAssertion } from './validator';
import type { ValidationError, ValidationResult } from './validator';

export type TaskSignatureInputType = 'string' | 'number' | 'boolean';
export type TaskSignatureInputRedaction = 'secret' | 'none';
export type TaskSignatureLoopGuardKind = 'max_same_tool' | 'max_observation_calls' | 'max_non_progress_calls';

export interface BrowserTaskSignatureInputSpec {
  type: TaskSignatureInputType;
  required: boolean;
  redaction?: TaskSignatureInputRedaction;
}

export interface BrowserTaskLoopGuard {
  kind: TaskSignatureLoopGuardKind;
  limit: number;
  window: number;
}

export interface BrowserTaskBudgets {
  maxToolCalls?: number;
  maxWallMs?: number;
}

export interface BrowserTaskSignature {
  version: 1;
  id: string;
  description: string;
  inputs: Record<string, BrowserTaskSignatureInputSpec>;
  allowedTools: string[];
  success: Assertion;
  stopWhen?: Assertion[];
  failureWhen?: Assertion[];
  loopGuards?: BrowserTaskLoopGuard[];
  budgets?: BrowserTaskBudgets;
}

export interface TaskSignatureToolCallSummary {
  tool: string;
  progressed?: boolean;
  observation?: boolean;
  ts?: number;
}

export type TaskSignatureStatus =
  | { status: 'continue'; reasons: string[] }
  | { status: 'success'; evidence: unknown }
  | { status: 'stop'; reasons: string[] }
  | { status: 'failure'; reasons: string[] }
  | { status: 'budget_exhausted'; reasons: string[] };

export interface TaskSignatureEvaluationInput {
  signature: BrowserTaskSignature;
  recentTools: TaskSignatureToolCallSummary[];
  elapsedMs: number;
  toolCount: number;
  assertionEvaluator?: (assertion: Assertion) => Promise<EvaluationResult> | EvaluationResult;
}

const INPUT_TYPES = new Set<TaskSignatureInputType>(['string', 'number', 'boolean']);
const REDACTIONS = new Set<TaskSignatureInputRedaction>(['secret', 'none']);
const LOOP_GUARDS = new Set<TaskSignatureLoopGuardKind>(['max_same_tool', 'max_observation_calls', 'max_non_progress_calls']);
const OBSERVATION_TOOLS = new Set(['read_page', 'screenshot', 'find', 'query_dom', 'extract_data']);

export function validateBrowserTaskSignature(input: unknown): ValidationResult<BrowserTaskSignature> {
  const errors: ValidationError[] = [];
  const value = validateSignatureObject(input, '$', errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as BrowserTaskSignature };
}

export function redactTaskSignatureInputs(
  signature: BrowserTaskSignature,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = signature.inputs[key];
    redacted[key] = spec?.redaction === 'secret' ? '[REDACTED]' : value;
  }
  return redacted;
}

export function preflightAllowedTools(
  signature: BrowserTaskSignature,
  plannedTools: string[],
): Extract<TaskSignatureStatus, { status: 'failure' }> | null {
  const allowed = new Set(signature.allowedTools);
  const disallowed = plannedTools.filter((tool) => !allowed.has(tool));
  if (disallowed.length === 0) return null;
  return {
    status: 'failure',
    reasons: [`signature ${signature.id} disallows tool(s): ${Array.from(new Set(disallowed)).join(', ')}`],
  };
}

export async function evaluateTaskSignature(input: TaskSignatureEvaluationInput): Promise<TaskSignatureStatus> {
  const { signature, recentTools, elapsedMs, toolCount, assertionEvaluator } = input;

  const budgetReasons = evaluateBudgets(signature, elapsedMs, toolCount);
  if (budgetReasons.length > 0) return { status: 'budget_exhausted', reasons: budgetReasons };

  const guardReasons = evaluateLoopGuards(signature, recentTools);
  if (guardReasons.length > 0) return { status: 'stop', reasons: guardReasons };

  if (assertionEvaluator) {
    for (const assertion of signature.failureWhen ?? []) {
      const result = await assertionEvaluator(assertion);
      if (result.passed) return { status: 'failure', reasons: [`failureWhen assertion '${assertion.kind}' passed`] };
    }
    for (const assertion of signature.stopWhen ?? []) {
      const result = await assertionEvaluator(assertion);
      if (result.passed) return { status: 'stop', reasons: [`stopWhen assertion '${assertion.kind}' passed`] };
    }
    const success = await assertionEvaluator(signature.success);
    if (success.passed) return { status: 'success', evidence: success.evidence };
  }

  return { status: 'continue', reasons: [] };
}

function validateSignatureObject(input: unknown, path: string, errors: ValidationError[]): BrowserTaskSignature | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ path, message: 'expected object' });
    return null;
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) errors.push({ path: `${path}.version`, message: 'expected version 1' });
  const id = requireNonEmptyString(obj, 'id', path, errors);
  const description = requireNonEmptyString(obj, 'description', path, errors);
  const inputs = validateInputs(obj.inputs, `${path}.inputs`, errors);
  const allowedTools = validateAllowedTools(obj.allowedTools, `${path}.allowedTools`, errors);
  const success = validateNestedAssertion(obj.success, `${path}.success`, errors);
  const stopWhen = validateOptionalAssertionArray(obj.stopWhen, `${path}.stopWhen`, errors);
  const failureWhen = validateOptionalAssertionArray(obj.failureWhen, `${path}.failureWhen`, errors);
  const loopGuards = validateLoopGuards(obj.loopGuards, `${path}.loopGuards`, errors);
  const budgets = validateBudgetsObject(obj.budgets, `${path}.budgets`, errors);
  if (!id || !description || !inputs || !allowedTools || !success) return null;
  return { version: 1, id, description, inputs, allowedTools, success, ...(stopWhen ? { stopWhen } : {}), ...(failureWhen ? { failureWhen } : {}), ...(loopGuards ? { loopGuards } : {}), ...(budgets ? { budgets } : {}) };
}

function requireNonEmptyString(obj: Record<string, unknown>, field: string, path: string, errors: ValidationError[]): string | null {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ path: `${path}.${field}`, message: 'expected non-empty string' });
    return null;
  }
  return value;
}

function validateInputs(input: unknown, path: string, errors: ValidationError[]): Record<string, BrowserTaskSignatureInputSpec> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ path, message: 'expected object' });
    return null;
  }
  const result: Record<string, BrowserTaskSignatureInputSpec> = {};
  for (const [name, rawSpec] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push({ path: `${path}.${name}`, message: 'input name must be identifier-like' });
      continue;
    }
    if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      errors.push({ path: `${path}.${name}`, message: 'expected object' });
      continue;
    }
    const spec = rawSpec as Record<string, unknown>;
    const validType = typeof spec.type === 'string' && INPUT_TYPES.has(spec.type as TaskSignatureInputType);
    if (!validType) errors.push({ path: `${path}.${name}.type`, message: 'expected one of string|number|boolean' });
    if (typeof spec.required !== 'boolean') errors.push({ path: `${path}.${name}.required`, message: 'expected boolean' });
    if (spec.redaction !== undefined && (typeof spec.redaction !== 'string' || !REDACTIONS.has(spec.redaction as TaskSignatureInputRedaction))) {
      errors.push({ path: `${path}.${name}.redaction`, message: 'expected one of secret|none' });
    }
    if (validType && typeof spec.required === 'boolean' && (spec.redaction === undefined || (typeof spec.redaction === 'string' && REDACTIONS.has(spec.redaction as TaskSignatureInputRedaction)))) {
      result[name] = { type: spec.type as TaskSignatureInputType, required: spec.required, ...(spec.redaction ? { redaction: spec.redaction as TaskSignatureInputRedaction } : {}) };
    }
  }
  return result;
}

function validateAllowedTools(input: unknown, path: string, errors: ValidationError[]): string[] | null {
  if (!Array.isArray(input) || input.length === 0) {
    errors.push({ path, message: 'expected non-empty array' });
    return null;
  }
  const tools: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const tool = input[i];
    if (typeof tool !== 'string' || tool.trim() === '') {
      errors.push({ path: `${path}.${i}`, message: 'expected non-empty string' });
      continue;
    }
    tools.push(tool);
  }
  return tools.length === input.length ? Array.from(new Set(tools)) : null;
}

function validateNestedAssertion(input: unknown, path: string, errors: ValidationError[]): Assertion | null {
  const result = validateAssertion(input);
  if (!result.ok) {
    errors.push(...result.errors.map((error) => ({ path: error.path.replace(/^\$/, path), message: error.message })));
    return null;
  }
  return result.value;
}

function validateOptionalAssertionArray(input: unknown, path: string, errors: ValidationError[]): Assertion[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    errors.push({ path, message: 'expected array' });
    return undefined;
  }
  const assertions: Assertion[] = [];
  for (let i = 0; i < input.length; i++) {
    const assertion = validateNestedAssertion(input[i], `${path}.${i}`, errors);
    if (assertion) assertions.push(assertion);
  }
  return assertions.length === input.length ? assertions : undefined;
}

function validateLoopGuards(input: unknown, path: string, errors: ValidationError[]): BrowserTaskLoopGuard[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    errors.push({ path, message: 'expected array' });
    return undefined;
  }
  const guards: BrowserTaskLoopGuard[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ path: `${path}.${i}`, message: 'expected object' });
      continue;
    }
    const guard = raw as Record<string, unknown>;
    const validKind = typeof guard.kind === 'string' && LOOP_GUARDS.has(guard.kind as TaskSignatureLoopGuardKind);
    if (!validKind) errors.push({ path: `${path}.${i}.kind`, message: 'expected known loop guard kind' });
    if (!isPositiveInteger(guard.limit)) errors.push({ path: `${path}.${i}.limit`, message: 'expected positive integer' });
    if (!isPositiveInteger(guard.window)) errors.push({ path: `${path}.${i}.window`, message: 'expected positive integer' });
    if (isPositiveInteger(guard.limit) && isPositiveInteger(guard.window) && guard.limit > guard.window) {
      errors.push({ path: `${path}.${i}.limit`, message: 'limit must be <= window' });
    }
    if (validKind && isPositiveInteger(guard.limit) && isPositiveInteger(guard.window) && guard.limit <= guard.window) {
      guards.push({ kind: guard.kind as TaskSignatureLoopGuardKind, limit: guard.limit, window: guard.window });
    }
  }
  return guards.length === input.length ? guards : undefined;
}

function validateBudgetsObject(input: unknown, path: string, errors: ValidationError[]): BrowserTaskBudgets | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ path, message: 'expected object' });
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const budgets: BrowserTaskBudgets = {};
  if (raw.maxToolCalls !== undefined) {
    if (!isPositiveInteger(raw.maxToolCalls)) errors.push({ path: `${path}.maxToolCalls`, message: 'expected positive integer' });
    else budgets.maxToolCalls = raw.maxToolCalls;
  }
  if (raw.maxWallMs !== undefined) {
    if (!isPositiveInteger(raw.maxWallMs)) errors.push({ path: `${path}.maxWallMs`, message: 'expected positive integer' });
    else budgets.maxWallMs = raw.maxWallMs;
  }
  return budgets;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function evaluateBudgets(signature: BrowserTaskSignature, elapsedMs: number, toolCount: number): string[] {
  const reasons: string[] = [];
  if (signature.budgets?.maxToolCalls !== undefined && toolCount >= signature.budgets.maxToolCalls) {
    reasons.push(`maxToolCalls exhausted: ${toolCount}/${signature.budgets.maxToolCalls}`);
  }
  if (signature.budgets?.maxWallMs !== undefined && elapsedMs >= signature.budgets.maxWallMs) {
    reasons.push(`maxWallMs exhausted: ${elapsedMs}/${signature.budgets.maxWallMs}`);
  }
  return reasons;
}

function evaluateLoopGuards(signature: BrowserTaskSignature, recentTools: TaskSignatureToolCallSummary[]): string[] {
  const reasons: string[] = [];
  for (const guard of signature.loopGuards ?? []) {
    const window = recentTools.slice(-guard.window);
    if (window.length < guard.limit) continue;
    if (guard.kind === 'max_same_tool') {
      const counts = new Map<string, number>();
      for (const call of window) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
      for (const [tool, count] of counts) {
        if (count >= guard.limit) reasons.push(`max_same_tool exceeded for ${tool}: ${count}/${guard.limit}`);
      }
    } else if (guard.kind === 'max_observation_calls') {
      const observations = window.filter((call) => call.observation ?? OBSERVATION_TOOLS.has(call.tool)).length;
      if (observations >= guard.limit) reasons.push(`max_observation_calls exceeded: ${observations}/${guard.limit}`);
    } else if (guard.kind === 'max_non_progress_calls') {
      const nonProgress = window.filter((call) => call.progressed === false).length;
      if (nonProgress >= guard.limit) reasons.push(`max_non_progress_calls exceeded: ${nonProgress}/${guard.limit}`);
    }
  }
  return reasons;
}
