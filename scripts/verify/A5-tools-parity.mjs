/**
 * A5 tools/list parity allow-list for request_intercept (#861).
 *
 * The only permitted diff vs v1.11.0 fixture:
 *   - description of `request_intercept`: updated to document the new `preset` field.
 *   - inputSchema of `request_intercept`: one new optional `preset` property added.
 *
 * All other tools must be byte-identical.
 */
export const ALLOW_LIST = {
  /** Tools whose description is permitted to differ from the v1.11.0 fixture. */
  descriptionChanged: ['request_intercept'],

  /**
   * Tools whose inputSchema is permitted to have additive-only changes
   * (new optional properties; no existing properties removed or type-changed).
   */
  schemaAdditive: ['request_intercept'],

  /**
   * New optional fields added to request_intercept schema.
   * Verifier must confirm: field is present, type is 'string', it is NOT in `required`.
   */
  newOptionalFields: {
    request_intercept: ['preset'],
  },
};
