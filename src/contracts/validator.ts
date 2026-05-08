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
  NetworkSinceMarker,
} from './types';
import { validateRegexPattern } from './safe-regex';

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

const KNOWN_KINDS = new Set([
  'url',
  'dom_text',
  'dom_count',
  'network',
  'screenshot_class',
  'no_dialog',
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
  if (!/^[A-Za-z0-9._-]+$/.test(classId)) {
    errors.push({
      path: `${path}.class_id`,
      message: 'class_id may only contain alphanumerics, dot, underscore, hyphen',
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
