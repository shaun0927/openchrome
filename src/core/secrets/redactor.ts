/**
 * Secret redactor (#834)
 *
 * Replaces literal secret VALUES with `${SECRET:NAME}` placeholders across an
 * arbitrary JSON-shaped value tree. This is the last line of defense — every
 * LLM-visible artifact (tool response, trace event, skill record, journal)
 * must pass through `redactSecrets` so a raw credential never reaches the
 * outer envelope.
 *
 * Performance budget: median ≤ 1 ms per response with 100 secrets across
 * 1000 simulated responses (see `__bench__/redact.bench.ts`). The default
 * algorithm is a single-pass substring scan with String#replaceAll over
 * sorted-by-length secret values — Aho-Corasick remains an option if the
 * cap is ever raised above 100.
 *
 * The function is pure: the input is never mutated; output is a JSON-shaped
 * clone with strings rewritten.
 */

import type { SecretStore } from './loader';
import { getSecretStore } from './loader';

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Precompiled view over a SecretStore: stable, length-sorted (longest first
 * so substrings cannot mask their superstring) and pre-escaped for regex
 * construction. We build this at most once per redactor call and reuse it
 * inside the walker.
 */
interface CompiledSecrets {
  /** [name, value] pairs, sorted by value length descending. */
  pairs: Array<{ name: string; value: string }>;
  /** Quick reject: any string shorter than this cannot match any secret. */
  minLen: number;
}

/**
 * Cache compiled views per SecretStore identity. The store is immutable
 * after `setSecretStore()`, so memoization is safe — no invalidation
 * needed. WeakMap keeps the cache GC-friendly when the store is replaced
 * (e.g. tests that swap in EMPTY_SECRET_STORE between runs).
 *
 * Without this cache `compile()` ran on every `redactSecrets()` call,
 * sorting N pairs per response × 2-3 redaction sites per tool call. With
 * the cache, every response after the first amortises to O(N) substring
 * scan only.
 */
const compileCache = new WeakMap<SecretStore, CompiledSecrets>();

function compile(store: SecretStore): CompiledSecrets {
  const cached = compileCache.get(store);
  if (cached !== undefined) return cached;

  const pairs: Array<{ name: string; value: string }> = [];
  let minLen = Number.POSITIVE_INFINITY;
  for (const [name, value] of store.entries()) {
    if (value.length === 0) continue; // empty values never match
    pairs.push({ name, value });
    if (value.length < minLen) minLen = value.length;
  }
  pairs.sort((a, b) => b.value.length - a.value.length);
  const compiled: CompiledSecrets = {
    pairs,
    minLen: pairs.length === 0 ? 0 : minLen,
  };
  compileCache.set(store, compiled);
  return compiled;
}

/**
 * Replace every literal occurrence of a known secret value inside `input`
 * with the corresponding `${SECRET:NAME}` placeholder. Returns the input
 * unchanged if no secret is loaded or no value is found (avoids any
 * allocation in the hot path).
 */
function redactString(input: string, compiled: CompiledSecrets): string {
  if (compiled.pairs.length === 0) return input;
  if (input.length < compiled.minLen) return input;
  let out = input;
  for (const { name, value } of compiled.pairs) {
    if (out.length < value.length) continue;
    if (!out.includes(value)) continue;
    // Use a global replace so all occurrences are caught in one pass.
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), `\${SECRET:${name}}`);
  }
  return out;
}

function walk(value: unknown, compiled: CompiledSecrets): unknown {
  if (typeof value === 'string') {
    return redactString(value, compiled);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = walk(value[i], compiled);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    // Preserve own enumerable keys; values are walked, keys are not (a key
    // shaped like a secret value would mean the secret IS the field name,
    // which we don't model — and rewriting keys would break agent contracts).
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, compiled);
    }
    return out;
  }
  return value;
}

/**
 * Redact secrets from an arbitrary JSON-shaped value using the supplied
 * store. If `store` is omitted the process-wide singleton is used. Returns
 * the input unchanged when the store is empty.
 */
export function redactSecrets<T>(value: T, store?: SecretStore): T {
  const s = store ?? getSecretStore();
  if (s.size === 0) return value;
  const compiled = compile(s);
  return walk(value, compiled) as T;
}

/** Convenience: redact a single string (avoids the walker overhead). */
export function redactSecretString(input: string, store?: SecretStore): string {
  const s = store ?? getSecretStore();
  if (s.size === 0) return input;
  const compiled = compile(s);
  return redactString(input, compiled);
}

/**
 * Defense-in-depth scan for `memory.set` — returns the first secret NAME
 * whose literal value appears as a substring inside `text`, or `undefined`
 * when none do. Uses the same compiled view, so the cost is identical to
 * one `redactSecrets()` pass.
 */
export function findLiteralSecret(text: string, store?: SecretStore): string | undefined {
  const s = store ?? getSecretStore();
  if (s.size === 0) return undefined;
  if (text.length === 0) return undefined;
  for (const [name, value] of s.entries()) {
    if (value.length === 0) continue;
    if (text.length < value.length) continue;
    if (text.includes(value)) return name;
  }
  return undefined;
}
