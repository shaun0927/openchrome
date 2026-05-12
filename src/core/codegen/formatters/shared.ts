/**
 * Shared helpers for codegen formatters (issue #836).
 *
 * The only non-trivial helper is `jsLiteral`, which serialises an arbitrary
 * value into a TS source literal that is safe to drop into a generated
 * file. We deliberately use `JSON.stringify` for strings so that secrets
 * placeholders such as `${SECRET:NAME}` survive verbatim (JSON.stringify
 * does not interpret template-literal syntax) and so that backticks,
 * newlines, and quotes are escaped correctly.
 */

/**
 * Serialise a JS value to a TS source literal for inclusion in generated code.
 *
 * - Strings → JSON-quoted (`"..."`) so embedded `${...}` placeholders pass
 *   through unchanged and never become template-string substitutions.
 * - Numbers / booleans / null → their TS literal form.
 * - undefined → the literal `undefined`.
 * - Objects / arrays → `JSON.stringify` output (good enough for the
 *   plain-data args the nine supported tools receive).
 */
export function jsLiteral(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Object / array fallthrough — best-effort JSON literal.
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserialisable>"';
  }
}
