/**
 * Structural validator for Outcome Contract assertions.
 *
 * Runs at the boundary (when a contract is registered or a postcondition
 * is parsed from a tool call). Returns *all* errors in one batch so an
 * LLM can fix multiple problems in a single retry.
 *
 * Validation is purely structural — does the shape match the type? It
 * does NOT evaluate against a page; that's the evaluator's job.
 *
 * Per #705 v2 P0 fixes:
 *   - `not` must have exactly one `child` (not an array of children).
 *   - `op` must be one of the string enums.
 *   - `screenshot_class.distance_max` must be in [0, 64].
 *   - `network.since` must be `contract_enter` or `last_tool_call`.
 *   - `and` / `or` must have ≥1 children.
 *   - All `pattern` / `url_pattern` strings must compile as RegExp.
 */

import type {
  Assertion,
  AssertionKind,
  DomCountOp,
  NetworkSinceMode,
} from './types';

export interface ValidationError {
  /** JSON-Pointer-ish path describing where the error lives. */
  path: string;
  message: string;
  /** Coarse category — useful for grouping in UIs. */
  code:
    | 'unknown_kind'
    | 'missing_field'
    | 'wrong_type'
    | 'out_of_range'
    | 'invalid_regex'
    | 'empty_children'
    | 'unknown_enum'
    | 'unexpected_field';
}

const VALID_DOM_COUNT_OPS: ReadonlySet<DomCountOp> = new Set(['eq', 'gte', 'lte']);
const VALID_NETWORK_SINCE: ReadonlySet<NetworkSinceMode> = new Set([
  'contract_enter',
  'last_tool_call',
]);

const KNOWN_KINDS: ReadonlySet<AssertionKind> = new Set<AssertionKind>([
  'url',
  'dom_text',
  'dom_count',
  'no_dialog',
  'network',
  'screenshot_class',
  'and',
  'or',
  'not',
]);

/** Validate an entire assertion tree. Empty array means valid. */
export function validateAssertion(value: unknown, path = '$'): ValidationError[] {
  const errors: ValidationError[] = [];
  validateOne(value, path, errors);
  return errors;
}

function validateOne(
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (!isPlainObject(value)) {
    errors.push({ path, code: 'wrong_type', message: 'expected object' });
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== 'string') {
    errors.push({ path: `${path}.kind`, code: 'missing_field', message: 'kind must be a string' });
    return;
  }
  if (!KNOWN_KINDS.has(obj.kind as AssertionKind)) {
    errors.push({
      path: `${path}.kind`,
      code: 'unknown_kind',
      message: `unknown assertion kind "${obj.kind}"`,
    });
    return;
  }

  switch (obj.kind as AssertionKind) {
    case 'url':
      requireString(obj, 'pattern', path, errors);
      validateRegex(obj.pattern, `${path}.pattern`, errors);
      return;
    case 'dom_text':
      if ('selector' in obj && obj.selector !== undefined) {
        requireString(obj, 'selector', path, errors);
      }
      requireString(obj, 'contains', path, errors);
      return;
    case 'dom_count':
      requireString(obj, 'selector', path, errors);
      requireEnum(obj, 'op', path, VALID_DOM_COUNT_OPS, errors);
      requireFiniteNumber(obj, 'value', path, errors);
      return;
    case 'no_dialog':
      return;
    case 'network':
      requireString(obj, 'url_pattern', path, errors);
      validateRegex(obj.url_pattern, `${path}.url_pattern`, errors);
      requireHttpStatusArray(obj, 'status_in', path, errors);
      requireEnum(obj, 'since', path, VALID_NETWORK_SINCE, errors);
      return;
    case 'screenshot_class':
      requireString(obj, 'class_id', path, errors);
      requireFiniteNumber(obj, 'distance_max', path, errors);
      if (typeof obj.distance_max === 'number' && Number.isFinite(obj.distance_max)) {
        if (!Number.isInteger(obj.distance_max)) {
          errors.push({
            path: `${path}.distance_max`,
            code: 'wrong_type',
            message: 'distance_max must be an integer (Hamming distance is integer-valued)',
          });
        } else if (obj.distance_max < 0 || obj.distance_max > 64) {
          errors.push({
            path: `${path}.distance_max`,
            code: 'out_of_range',
            message: 'distance_max must be in [0, 64] (Hamming distance over 64-bit pHash)',
          });
        }
      }
      return;
    case 'and':
    case 'or': {
      const children = obj.children;
      if (!Array.isArray(children)) {
        errors.push({
          path: `${path}.children`,
          code: 'wrong_type',
          message: 'children must be an array',
        });
        return;
      }
      if (children.length < 1) {
        errors.push({
          path: `${path}.children`,
          code: 'empty_children',
          message: `${obj.kind} must have ≥1 children`,
        });
      }
      children.forEach((c, i) => validateOne(c, `${path}.children[${i}]`, errors));
      return;
    }
    case 'not':
      if (!('child' in obj) || obj.child === undefined) {
        errors.push({
          path: `${path}.child`,
          code: 'missing_field',
          message: 'not requires a single `child` (not `children`)',
        });
        return;
      }
      // Reject mixed payloads where the author also supplied `children`.
      // Silently ignoring the extra field hides authoring mistakes whose
      // intent (multi-child negation) cannot be represented by `not`.
      if ('children' in obj) {
        errors.push({
          path: `${path}.children`,
          code: 'unexpected_field',
          message: 'not takes a single `child`; remove `children` (use `and`/`or` for multi-child composition)',
        });
      }
      validateOne(obj.child, `${path}.child`, errors);
      return;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  errors: ValidationError[],
): void {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    errors.push({
      path: `${path}.${field}`,
      code: typeof v === 'string' ? 'wrong_type' : 'missing_field',
      message: `${field} must be a non-empty string`,
    });
  }
}

function requireFiniteNumber(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  errors: ValidationError[],
): void {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push({
      path: `${path}.${field}`,
      code: typeof v === 'number' ? 'wrong_type' : 'missing_field',
      message: `${field} must be a finite number`,
    });
  }
}

function requireEnum<E extends string>(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  allowed: ReadonlySet<E>,
  errors: ValidationError[],
): void {
  const v = obj[field];
  if (typeof v !== 'string') {
    errors.push({
      path: `${path}.${field}`,
      code: 'missing_field',
      message: `${field} must be a string enum`,
    });
    return;
  }
  if (!allowed.has(v as E)) {
    errors.push({
      path: `${path}.${field}`,
      code: 'unknown_enum',
      message: `${field} must be one of: ${[...allowed].join(', ')}`,
    });
  }
}

function requireNumberArray(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  errors: ValidationError[],
): void {
  const v = obj[field];
  if (!Array.isArray(v)) {
    errors.push({
      path: `${path}.${field}`,
      code: 'wrong_type',
      message: `${field} must be an array of numbers`,
    });
    return;
  }
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      errors.push({
        path: `${path}.${field}[${i}]`,
        code: 'wrong_type',
        message: 'expected finite number',
      });
    }
  }
}

/** HTTP status codes are integer-valued in [100, 599]. Anything else
 *  cannot match a real response and should fail registration so the
 *  contract author can correct the typo before runtime evaluation. */
function requireHttpStatusArray(
  obj: Record<string, unknown>,
  field: string,
  path: string,
  errors: ValidationError[],
): void {
  const v = obj[field];
  if (!Array.isArray(v)) {
    errors.push({
      path: `${path}.${field}`,
      code: 'wrong_type',
      message: `${field} must be an array of HTTP status codes`,
    });
    return;
  }
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      errors.push({
        path: `${path}.${field}[${i}]`,
        code: 'wrong_type',
        message: 'expected finite number',
      });
      continue;
    }
    if (!Number.isInteger(item)) {
      errors.push({
        path: `${path}.${field}[${i}]`,
        code: 'wrong_type',
        message: 'HTTP status code must be an integer',
      });
      continue;
    }
    if (item < 100 || item > 599) {
      errors.push({
        path: `${path}.${field}[${i}]`,
        code: 'out_of_range',
        message: 'HTTP status code must be in [100, 599]',
      });
    }
  }
}

function validateRegex(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'string') return;
  try {
    new RegExp(value);
  } catch (e) {
    errors.push({
      path,
      code: 'invalid_regex',
      message: `regex failed to compile: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
