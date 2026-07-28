/**
 * Schema validator for the Outcome Contract DSL.
 *
 * Returns errors in a single batch so an LLM can correct multiple mistakes
 * at once — the runtime never accepts a partially-valid Assertion.
 */

import type {
  Assertion,
  AndAssertion,
  OrAssertion,
  NotAssertion,
  ComparisonOp,
  ConsoleAssertion,
  NetworkSinceMarker,
  PerformanceAssertion,
} from './types';
import { validateRegexPattern } from './safe-regex';
import {
  CONTRACT_FACT_SCHEMA_VERSION,
  MAX_CONTRACT_FACT_AGE_MS,
  type PerformanceUnit,
} from './contract-facts';

export interface ValidationError {
  /** Dotted JSON path to the offending node (e.g. `children.0.url.pattern`). */
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

const COMPARISON_OPS: ReadonlySet<ComparisonOp> = new Set(['eq', 'gte', 'lte']);
const NETWORK_SINCE: ReadonlySet<NetworkSinceMarker> = new Set([
  'contract_enter',
  'last_tool_call',
]);
const PERFORMANCE_UNITS: ReadonlySet<PerformanceUnit> = new Set([
  'ms',
  'seconds',
  'bytes',
  'count',
]);

const KNOWN_KINDS = new Set([
  'url',
  'dom_text',
  'dom_count',
  'network',
  'screenshot_class',
  'no_dialog',
  'image_qa',
  'performance',
  'console',
  'and',
  'or',
  'not',
]);

/**
 * Validate an unknown value as an `Assertion`. The DSL is JSON-serializable
 * so input may arrive as freshly-parsed JSON from a tool call.
 */
export function validateAssertion(input: unknown): ValidationResult<Assertion> {
  const errors: ValidationError[] = [];
  const value = walk(input, '$', errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as Assertion };
}

function walk(input: unknown, path: string, errors: ValidationError[]): Assertion | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({ path, message: 'expected object' });
    return null;
  }

  const obj = input as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== 'string') {
    errors.push({ path: `${path}.kind`, message: 'missing or non-string `kind`' });
    return null;
  }
  if (!KNOWN_KINDS.has(kind)) {
    errors.push({ path: `${path}.kind`, message: `unknown kind '${kind}'` });
    return null;
  }

  switch (kind) {
    case 'url':
      return validateUrl(obj, path, errors);
    case 'dom_text':
      return validateDomText(obj, path, errors);
    case 'dom_count':
      return validateDomCount(obj, path, errors);
    case 'network':
      return validateNetwork(obj, path, errors);
    case 'screenshot_class':
      return validateScreenshotClass(obj, path, errors);
    case 'no_dialog':
      return { kind: 'no_dialog' };
    case 'image_qa':
      return validateImageQa(obj, path, errors);
    case 'performance':
      return validatePerformance(obj, path, errors);
    case 'console':
      return validateConsole(obj, path, errors);
    case 'and':
    case 'or':
      return validateLogical(kind, obj, path, errors);
    case 'not':
      return validateNot(obj, path, errors);
    default:
      // Unreachable: KNOWN_KINDS gate above.
      return null;
  }
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  errors: ValidationError[],
): string | null {
  const value = obj[field];
  if (typeof value !== 'string') {
    errors.push({ path: `${path}.${field}`, message: `expected string` });
    return null;
  }
  return value;
}

function validateUrl(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): Assertion | null {
  const pattern = requireString(obj, 'pattern', path, errors);
  if (pattern === null) return null;
  const safety = validateRegexPattern(pattern);
  if (!safety.ok) {
    errors.push({ path: `${path}.pattern`, message: safety.reason });
    return null;
  }
  return { kind: 'url', pattern };
}

function validateDomText(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): Assertion | null {
  const contains = requireString(obj, 'contains', path, errors);
  if (contains === null) return null;
  let selector: string | undefined;
  if (obj.selector !== undefined) {
    if (typeof obj.selector !== 'string') {
      errors.push({ path: `${path}.selector`, message: 'expected string' });
      return null;
    }
    selector = obj.selector;
  }
  return selector === undefined
    ? { kind: 'dom_text', contains }
    : { kind: 'dom_text', selector, contains };
}

function validateDomCount(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): Assertion | null {
  const selector = requireString(obj, 'selector', path, errors);
  const op = obj.op;
  if (typeof op !== 'string' || !COMPARISON_OPS.has(op as ComparisonOp)) {
    errors.push({ path: `${path}.op`, message: 'expected one of eq|gte|lte' });
    return null;
  }
  const value = obj.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push({ path: `${path}.value`, message: 'expected non-negative integer' });
    return null;
  }
  if (value < 0) {
    errors.push({ path: `${path}.value`, message: 'value must be >= 0' });
    return null;
  }
  if (selector === null) return null;
  return { kind: 'dom_count', selector, op: op as ComparisonOp, value };
}

function validateNetwork(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): Assertion | null {
  const urlPattern = requireString(obj, 'url_pattern', path, errors);
  if (urlPattern !== null) {
    // url_pattern may be substring or regex; we only enforce the safety
    // guard if it parses as a regex. The runtime falls back to substring
    // semantics, which has no ReDoS surface.
    try {
      new RegExp(urlPattern);
      const safety = validateRegexPattern(urlPattern);
      if (!safety.ok) {
        errors.push({ path: `${path}.url_pattern`, message: safety.reason });
        return null;
      }
    } catch {
      // Not a regex — substring fallback is fine; still cap length.
      if (urlPattern.length > 512) {
        errors.push({
          path: `${path}.url_pattern`,
          message: 'pattern exceeds 512 chars',
        });
        return null;
      }
    }
  }
  const since = obj.since;
  if (typeof since !== 'string' || !NETWORK_SINCE.has(since as NetworkSinceMarker)) {
    errors.push({
      path: `${path}.since`,
      message: 'expected one of contract_enter|last_tool_call',
    });
    return null;
  }
  if (!Array.isArray(obj.status_in) || obj.status_in.length === 0) {
    errors.push({ path: `${path}.status_in`, message: 'expected non-empty array' });
    return null;
  }
  const statusIn: number[] = [];
  for (let i = 0; i < obj.status_in.length; i++) {
    const v = obj.status_in[i];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v >= 600) {
      errors.push({
        path: `${path}.status_in.${i}`,
        message: 'expected HTTP status integer in [100,599]',
      });
      return null;
    }
    statusIn.push(v);
  }
  if (urlPattern === null) return null;
  return {
    kind: 'network',
    url_pattern: urlPattern,
    status_in: statusIn,
    since: since as NetworkSinceMarker,
  };
}

function validateScreenshotClass(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): Assertion | null {
  const classId = requireString(obj, 'class_id', path, errors);
  const distanceMax = obj.distance_max;
  if (
    typeof distanceMax !== 'number' ||
    !Number.isInteger(distanceMax) ||
    distanceMax < 0 ||
    distanceMax > 64
  ) {
    errors.push({
      path: `${path}.distance_max`,
      message: 'expected integer in [0,64]',
    });
    return null;
  }
  if (classId === null) return null;
  // Mirror screenshot-class.ts: the regex accepts dot-only segments, so
  // reject `.` and `..` explicitly to keep DSL-supplied class_ids from
  // resolving to the registry root or its parent at use time.
  if (!/^[A-Za-z0-9._-]+$/.test(classId) || classId === '.' || classId === '..') {
    errors.push({
      path: `${path}.class_id`,
      message:
        "class_id may only contain alphanumerics, dot, underscore, hyphen and must not be '.' or '..'",
    });
    return null;
  }
  return { kind: 'screenshot_class', class_id: classId, distance_max: distanceMax };
}

function validateLogical(
  kind: 'and' | 'or',
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): AndAssertion | OrAssertion | null {
  if (!Array.isArray(obj.children) || obj.children.length === 0) {
    errors.push({
      path: `${path}.children`,
      message: 'expected non-empty array',
    });
    return null;
  }
  const children: Assertion[] = [];
  let hadError = false;
  for (let i = 0; i < obj.children.length; i++) {
    const child = walk(obj.children[i], `${path}.children.${i}`, errors);
    if (child === null) {
      hadError = true;
      continue;
    }
    children.push(child);
  }
  if (hadError) return null;
  return { kind, children };
}

function validateNot(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): NotAssertion | null {
  if (obj.child === undefined) {
    errors.push({ path: `${path}.child`, message: 'missing required field' });
    return null;
  }
  if ('children' in obj) {
    errors.push({
      path: `${path}.children`,
      message: '`not` takes a single `child`, not `children`',
    });
    return null;
  }
  const child = walk(obj.child, `${path}.child`, errors);
  if (child === null) return null;
  return { kind: 'not', child };
}

function validateImageQa(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): Assertion | null {
  const question = requireString(obj, 'question', path, errors);
  const pattern = requireString(obj, 'expected_pattern', path, errors);
  if (question === null || pattern === null) return null;
  const safety = validateRegexPattern(pattern);
  if (!safety.ok) {
    errors.push({ path: `${path}.expected_pattern`, message: safety.reason });
    return null;
  }
  return { kind: 'image_qa', question, expected_pattern: pattern };
}

function validatePerformance(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): PerformanceAssertion | null {
  let valid = validateFactSchemaVersion(obj, path, errors);
  const metric = requireString(obj, 'metric', path, errors);
  if (metric === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metric)) {
    if (metric !== null) {
      errors.push({
        path: `${path}.metric`,
        message: 'expected 1-128 chars: alphanumeric followed by alphanumeric/dot/underscore/hyphen',
      });
    }
    valid = false;
  }
  const unit = obj.unit;
  if (typeof unit !== 'string' || !PERFORMANCE_UNITS.has(unit as PerformanceUnit)) {
    errors.push({ path: `${path}.unit`, message: 'expected one of ms|seconds|bytes|count' });
    valid = false;
  }
  const op = validateComparisonOp(obj.op, path, errors);
  if (op === null) valid = false;
  const value = obj.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ path: `${path}.value`, message: 'expected finite number' });
    valid = false;
  }
  const maxAgeMs = validateMaxAge(obj.max_age_ms, path, errors);
  if (maxAgeMs === null) valid = false;
  if (!valid || metric === null || op === null || maxAgeMs === null) return null;
  return {
    kind: 'performance',
    schema_version: CONTRACT_FACT_SCHEMA_VERSION,
    metric,
    unit: unit as PerformanceUnit,
    op,
    value: value as number,
    max_age_ms: maxAgeMs,
  };
}

function validateConsole(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): ConsoleAssertion | null {
  let valid = validateFactSchemaVersion(obj, path, errors);
  let type: string | undefined;
  if (obj.type !== undefined) {
    if (typeof obj.type !== 'string' || obj.type.length === 0 || obj.type.length > 64) {
      errors.push({ path: `${path}.type`, message: 'expected non-empty string up to 64 chars' });
      valid = false;
    } else {
      type = obj.type;
    }
  }
  let messagePattern: string | undefined;
  if (obj.message_pattern !== undefined) {
    if (typeof obj.message_pattern !== 'string') {
      errors.push({ path: `${path}.message_pattern`, message: 'expected string' });
      valid = false;
    } else {
      const safety = validateRegexPattern(obj.message_pattern);
      if (!safety.ok) {
        errors.push({ path: `${path}.message_pattern`, message: safety.reason });
        valid = false;
      } else {
        messagePattern = obj.message_pattern;
      }
    }
  }
  let uncaught: boolean | undefined;
  if (obj.uncaught !== undefined) {
    if (typeof obj.uncaught !== 'boolean') {
      errors.push({ path: `${path}.uncaught`, message: 'expected boolean' });
      valid = false;
    } else {
      uncaught = obj.uncaught;
    }
  }
  const op = validateComparisonOp(obj.op, path, errors);
  if (op === null) valid = false;
  const value = obj.value;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    errors.push({ path: `${path}.value`, message: 'expected non-negative safe integer' });
    valid = false;
  }
  const maxAgeMs = validateMaxAge(obj.max_age_ms, path, errors);
  if (maxAgeMs === null) valid = false;
  if (!valid || op === null || maxAgeMs === null) return null;
  return {
    kind: 'console',
    schema_version: CONTRACT_FACT_SCHEMA_VERSION,
    ...(type !== undefined ? { type } : {}),
    ...(messagePattern !== undefined ? { message_pattern: messagePattern } : {}),
    ...(uncaught !== undefined ? { uncaught } : {}),
    op,
    value: value as number,
    max_age_ms: maxAgeMs,
  };
}

function validateFactSchemaVersion(
  obj: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): boolean {
  if (obj.schema_version !== CONTRACT_FACT_SCHEMA_VERSION) {
    errors.push({
      path: `${path}.schema_version`,
      message: `expected schema_version ${CONTRACT_FACT_SCHEMA_VERSION}`,
    });
    return false;
  }
  return true;
}

function validateComparisonOp(
  value: unknown,
  path: string,
  errors: ValidationError[],
): ComparisonOp | null {
  if (typeof value !== 'string' || !COMPARISON_OPS.has(value as ComparisonOp)) {
    errors.push({ path: `${path}.op`, message: 'expected one of eq|gte|lte' });
    return null;
  }
  return value as ComparisonOp;
}

function validateMaxAge(
  value: unknown,
  path: string,
  errors: ValidationError[],
): number | null {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_CONTRACT_FACT_AGE_MS
  ) {
    errors.push({
      path: `${path}.max_age_ms`,
      message: `expected integer in [0,${MAX_CONTRACT_FACT_AGE_MS}]`,
    });
    return null;
  }
  return value;
}
