/**
 * Schema diff — deterministic field-match between a declared target schema and
 * an observed object (issue: B1-PR1 of #1359 host-neutral harness initiative).
 *
 * This is a pure function. It has no I/O, no Chrome dependency, and no opinion
 * on what the caller does with the diff. It produces facts — not a score, not
 * a verdict. The host agent decides whether the coverage is "good enough" for
 * its workflow (CI gating, recovery, memory promotion, external benchmarking).
 *
 * Design rules:
 *
 *  - **Facts before decisions (P4).** Output is a structured diff. No threshold
 *    is encoded. The `coverage` ratio is provided as a convenience; callers
 *    that need a different metric can compute it from `matched`/`missing`.
 *  - **Deterministic.** Identical inputs produce byte-identical output. Field
 *    name ordering follows the schema definition order (matched/missing) or
 *    sorted observed-key order (extra). This lets traces and evidence bundles
 *    diff-cleanly across runs.
 *  - **Dot-path nested.** A field named `"user.email"` resolves to
 *    `observed.user.email`. Path segments are split on the literal `.` — a
 *    field whose actual key contains a dot is out of scope for v1 and should
 *    be modeled as a nested object.
 *  - **No throwing.** Malformed `observed` data (non-object root, null, etc.)
 *    is reported through `missing`/`typeMismatch` rather than thrown.
 *
 * @see issue #1359 §Pillar C (contract-verifiable browser work)
 */

/** JS-type bucket used by the schema. Mirrors `typeof` plus array and null. */
export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/** A single declared field. */
export interface SchemaField {
  /** Dot-path from the observed root. Example: `"user.email"`. */
  name: string;
  /** Expected JS type bucket. */
  type: SchemaFieldType;
  /**
   * Whether the field must be present and type-correct for the schema to be
   * "satisfied". Defaults to `true`. Optional fields never appear in
   * `missing` and do not contribute to the coverage denominator.
   */
  required?: boolean;
}

/** A declared target schema. */
export interface SchemaDefinition {
  /** Format version. Today only `1` is defined. */
  version: 1;
  fields: readonly SchemaField[];
}

/** One type-mismatch report. */
export interface SchemaTypeMismatch {
  field: string;
  expected: SchemaFieldType;
  got: SchemaFieldType;
}

/** Structured diff produced by {@link diffAgainstSchema}. */
export interface SchemaDiff {
  /** Schema field names that are present in `observed` with the expected type. */
  matched: string[];
  /**
   * Required schema field names that are absent in `observed`. Optional
   * fields that are absent are NOT reported here.
   */
  missing: string[];
  /**
   * Top-level observed keys that are not declared in the schema. Only the
   * top-level slice is enumerated — deep `extra` traversal would explode for
   * unknown shapes and is intentionally out of scope.
   */
  extra: string[];
  /** Fields that exist but with a different type bucket than declared. */
  typeMismatch: SchemaTypeMismatch[];
  /**
   * Required-field coverage in `[0, 1]`. Equal to
   * `matched_required / required_total`. When the schema declares zero
   * required fields, `coverage` is `1` by convention (vacuous truth).
   */
  coverage: number;
}

/** Classify a JS value into one of the schema field type buckets. */
export function classify(value: unknown): SchemaFieldType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  // undefined / function / symbol / bigint fall here. Treat as "not a tracked
  // bucket"; callers receive a typeMismatch with `got: 'null'` as a stand-in
  // so the output remains in the closed type set above. This is acceptable
  // because schemas should not declare these types in v1.
  return 'null';
}

/**
 * Walk a dot-path through an object. Returns `undefined` if any segment is
 * missing OR if any non-leaf segment is not a traversable object. Distinct
 * "missing key" vs "value is undefined" is intentionally not preserved — both
 * collapse to absent for v1.
 */
function readPath(root: unknown, dotPath: string): { found: boolean; value: unknown } {
  if (dotPath === '') return { found: true, value: root };
  const segments = dotPath.split('.');
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return { found: false, value: undefined };
    }
    const obj = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, segment)) {
      return { found: false, value: undefined };
    }
    cursor = obj[segment];
  }
  return { found: true, value: cursor };
}

/**
 * Compute the diff between a declared `target` schema and an `observed` value.
 *
 * The function never throws. A non-object `observed` is treated as if every
 * declared field is absent (all required fields go to `missing`, `extra` is
 * empty).
 */
export function diffAgainstSchema(
  target: SchemaDefinition,
  observed: unknown,
): SchemaDiff {
  const matched: string[] = [];
  const missing: string[] = [];
  const typeMismatch: SchemaTypeMismatch[] = [];

  let requiredTotal = 0;
  let matchedRequired = 0;

  for (const field of target.fields) {
    const isRequired = field.required !== false;
    if (isRequired) requiredTotal += 1;

    const probe = readPath(observed, field.name);
    if (!probe.found) {
      if (isRequired) missing.push(field.name);
      continue;
    }
    const actualType = classify(probe.value);
    if (actualType === field.type) {
      matched.push(field.name);
      if (isRequired) matchedRequired += 1;
    } else {
      typeMismatch.push({ field: field.name, expected: field.type, got: actualType });
    }
  }

  const extra: string[] = [];
  if (observed !== null && typeof observed === 'object' && !Array.isArray(observed)) {
    const declaredTopLevel = new Set<string>();
    for (const field of target.fields) {
      const top = field.name.split('.', 1)[0];
      if (top) declaredTopLevel.add(top);
    }
    const observedKeys = Object.keys(observed as Record<string, unknown>).sort();
    for (const key of observedKeys) {
      if (!declaredTopLevel.has(key)) extra.push(key);
    }
  }

  const coverage = requiredTotal === 0 ? 1 : matchedRequired / requiredTotal;

  return { matched, missing, extra, typeMismatch, coverage };
}
