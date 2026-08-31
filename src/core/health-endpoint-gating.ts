/**
 * Health endpoint gating resolver.
 *
 * Extracted as a pure function so it is trivially unit-testable and
 * re-usable. Operators opt into or out of the `/health` + `/metrics`
 * HTTP surface via `OPENCHROME_HEALTH_ENDPOINT`; when that env var is
 * unset (or invalid), we fall through to the transport-mode default.
 *
 * Default semantics (issue #648 §3.1):
 *   - `'1'` or `'true'`  → enabled (force-on).
 *   - `'0'` or `'false'` → disabled (force-off).
 *   - anything else (including `undefined`, `''`, `'garbage'`, `'yes'`) →
 *     enabled iff `transportMode` is `'http'` or `'both'`. Stdio-only
 *     launches skip the endpoint by default because stdio clients talk
 *     to openchrome over the pipe, not over HTTP, so the listener is
 *     dead weight (one FD + ~200 KB heap per instance).
 */
export function resolveHealthEndpointEnabled(
  transportMode: string,
  envOverride: string | undefined,
): boolean {
  if (envOverride === '1' || envOverride === 'true') return true;
  if (envOverride === '0' || envOverride === 'false') return false;
  return transportMode === 'http' || transportMode === 'both';
}
