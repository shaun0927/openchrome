/**
 * Secret substituter (#834)
 *
 * Inverse of `redactSecrets`: walks an object tree and replaces every
 * `${SECRET:NAME}` token inside string values with the real secret value
 * fetched from the store. This runs at the MCP request-argument
 * deserialization layer, before tool dispatch.
 *
 * Scope:
 *   • Substitution only occurs at whitelisted argument paths (see
 *     `WHITELISTED_SITES` in `src/mcp-server.ts`). The walker here is
 *     written generically so other call sites (skill replay) can use it,
 *     but the chokepoint is the whitelist — every callsite is reviewed.
 *   • A missing secret raises `MissingSecretError` so the caller can surface
 *     the structured `{ code: "MISSING_SECRET", name: "..." }` payload.
 *
 * Token grammar: `${SECRET:<NAME>}` where `<NAME>` matches
 * `[A-Za-z_][A-Za-z0-9_]*`. The leading `${SECRET:` is the strongest
 * disambiguator we can pick — agents that legitimately want a literal
 * `${SECRET:foo}` in a string must avoid that prefix.
 */

import type { SecretStore } from './loader';
import { getSecretStore } from './loader';

/** Matches `${SECRET:NAME}` globally; the name is captured in group 1. */
export const SECRET_TOKEN_RE = /\$\{SECRET:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class MissingSecretError extends Error {
  readonly code = 'MISSING_SECRET';
  readonly secretName: string;
  constructor(name: string) {
    super(`MISSING_SECRET: secret "${name}" is referenced but not loaded`);
    this.name = 'MissingSecretError';
    this.secretName = name;
  }
}

/** Whether a string contains at least one `${SECRET:NAME}` token. */
export function hasSecretToken(input: string): boolean {
  // Resetting lastIndex is required because the regex is /g.
  SECRET_TOKEN_RE.lastIndex = 0;
  return SECRET_TOKEN_RE.test(input);
}

/**
 * Substitute every `${SECRET:NAME}` token inside the string. Throws
 * `MissingSecretError` on the first unknown name. The match is anchored on
 * a closed brace, so partial tokens like `${SECRET:FOO` pass through
 * unchanged (no exception, no replacement).
 */
export function substituteString(input: string, store: SecretStore): string {
  if (input.length === 0) return input;
  if (!input.includes('${SECRET:')) return input;
  // Walk all matches first to surface MISSING_SECRET deterministically
  // (replace() swallows errors thrown from its callback in some runtimes).
  SECRET_TOKEN_RE.lastIndex = 0;
  const matches: Array<{ name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = SECRET_TOKEN_RE.exec(input)) !== null) {
    matches.push({ name: m[1] });
  }
  for (const { name } of matches) {
    if (!store.has(name)) {
      throw new MissingSecretError(name);
    }
  }
  SECRET_TOKEN_RE.lastIndex = 0;
  return input.replace(SECRET_TOKEN_RE, (_full, name: string) => {
    const v = store.get(name);
    // Existence was checked above; this fallback exists only for type safety.
    if (v === undefined) throw new MissingSecretError(name);
    return v;
  });
}

function walk(value: unknown, store: SecretStore): unknown {
  if (typeof value === 'string') {
    return substituteString(value, store);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = walk(value[i], store);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, store);
    }
    return out;
  }
  return value;
}

/**
 * Substitute every `${SECRET:NAME}` token inside a value tree. Returns the
 * tree unchanged when the store is empty. Throws `MissingSecretError` on
 * the first unknown name.
 */
export function substituteSecrets<T>(value: T, store?: SecretStore): T {
  const s = store ?? getSecretStore();
  if (s.size === 0) {
    // Even when the store is empty we must still surface MISSING_SECRET for
    // any token present in the value (scenario 5: replay without --secrets).
    return substituteWithThrow(value, s) as T;
  }
  return walk(value, s) as T;
}

/**
 * Variant that runs the missing-secret check even when the store is empty.
 * Separated so the happy-path early-return in `substituteSecrets` can avoid
 * the walker when neither tokens nor secrets are involved.
 */
function substituteWithThrow(value: unknown, store: SecretStore): unknown {
  if (typeof value === 'string') {
    if (!value.includes('${SECRET:')) return value;
    return substituteString(value, store);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteWithThrow(v, store));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteWithThrow(v, store);
    }
    return out;
  }
  return value;
}
