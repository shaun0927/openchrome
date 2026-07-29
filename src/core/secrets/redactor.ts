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
  /** One-pass literal matcher; alternatives are longest-first. */
  matcher?: RegExp;
  /** Canonical replacement name for each distinct secret value. */
  valueToName: Map<string, string>;
  /** Loaded names that make an existing placeholder canonical. */
  names: Set<string>;
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
const SECRET_PLACEHOLDER_RE = /\$\{SECRET:([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface SecretMatch {
  start: number;
  end: number;
  name: string;
}

interface ProtectedPlaceholder {
  start: number;
  end: number;
  token: string;
}

export interface SecretStringRedactionResult {
  value: string;
  lossy: boolean;
}

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
  const valueToName = new Map<string, string>();
  for (const { name, value } of pairs) {
    if (!valueToName.has(value)) valueToName.set(value, name);
  }
  const compiled: CompiledSecrets = {
    pairs,
    minLen: pairs.length === 0 ? 0 : minLen,
    ...(pairs.length > 0
      ? { matcher: new RegExp(pairs.map(({ value }) => escapeRegExp(value)).join('|'), 'g') }
      : {}),
    valueToName,
    names: new Set(Array.from(store.names())),
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
function redactUnprotectedString(input: string, compiled: CompiledSecrets): string {
  if (!compiled.matcher) return input;
  if (input.length < compiled.minLen) return input;
  compiled.matcher.lastIndex = 0;
  return input.replace(compiled.matcher, (value) => (
    `\${SECRET:${compiled.valueToName.get(value) as string}}`
  ));
}

function redactString(input: string, compiled: CompiledSecrets): string {
  return redactStringWithMetadata(input, compiled).value;
}

function redactStringWithMetadata(
  input: string,
  compiled: CompiledSecrets,
): SecretStringRedactionResult {
  if (!input.includes('${SECRET:')) {
    const redacted = redactUnprotectedString(input, compiled);
    return redacted === input
      ? { value: input, lossy: false }
      : stabilizeRedactedString(redacted, compiled);
  }
  const secretMatches = collectOverlappingSecretMatches(input, compiled);
  const ignoredSecretIndexes = new Set<number>();
  const expandedBoundaryMatches = new Map<number, SecretMatch>();
  const protectedPlaceholders: ProtectedPlaceholder[] = [];
  const placeholders: Array<ProtectedPlaceholder & { canonical: boolean }> = [];
  let boundaryExpansionLossy = false;
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  for (const match of input.matchAll(SECRET_PLACEHOLDER_RE)) {
    const start = match.index ?? 0;
    const token = match[0];
    const name = match[1];
    placeholders.push({
      start,
      end: start + token.length,
      token,
      canonical: compiled.names.has(name),
    });
  }

  let nextSecret = 0;
  let activeSecretIndexes: number[] = [];
  for (const placeholder of placeholders) {
    const { start, end, token, canonical } = placeholder;
    activeSecretIndexes = activeSecretIndexes.filter((index) => (
      secretMatches[index].end > start
    ));
    while (
      nextSecret < secretMatches.length
      && secretMatches[nextSecret].start < end
    ) {
      if (secretMatches[nextSecret].end > start) activeSecretIndexes.push(nextSecret);
      nextSecret++;
    }
    const internalIndexes: number[] = [];
    const boundaryIndexes: number[] = [];
    for (const index of activeSecretIndexes) {
      const secret = secretMatches[index];
      if (secret.start > start && secret.end < end) internalIndexes.push(index);
      else boundaryIndexes.push(index);
    }
    if (boundaryIndexes.length > 0) {
      for (const index of internalIndexes) ignoredSecretIndexes.add(index);
      for (const index of boundaryIndexes) {
        ignoredSecretIndexes.add(index);
        const secret = secretMatches[index];
        const expanded = expandedBoundaryMatches.get(index) ?? { ...secret };
        expanded.start = Math.min(expanded.start, start);
        expanded.end = Math.max(expanded.end, end);
        if (expanded.start !== secret.start || expanded.end !== secret.end) {
          boundaryExpansionLossy = true;
        }
        expandedBoundaryMatches.set(index, expanded);
      }
    } else if (canonical) {
      protectedPlaceholders.push({ start, end, token });
      for (const index of internalIndexes) ignoredSecretIndexes.add(index);
    }
  }

  const effectiveSecrets = selectNonOverlappingSecretMatches(
    secretMatches
      .filter((_, index) => !ignoredSecretIndexes.has(index))
      .concat(Array.from(expandedBoundaryMatches.values()))
      .sort((a, b) => (
        a.start - b.start || (b.end - b.start) - (a.end - a.start)
      )),
  );
  const controls = [
    ...effectiveSecrets.map((secret) => ({
      start: secret.start,
      end: secret.end,
      replacement: `\${SECRET:${secret.name}}`,
    })),
    ...protectedPlaceholders.map((placeholder) => ({
      start: placeholder.start,
      end: placeholder.end,
      replacement: placeholder.token,
    })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  let cursor = 0;
  let out = '';
  for (const control of controls) {
    if (control.start < cursor) continue;
    out += input.slice(cursor, control.start);
    out += control.replacement;
    cursor = control.end;
  }
  out += input.slice(cursor);
  const stabilized = stabilizeRedactedString(out, compiled);
  return {
    value: stabilized.value,
    lossy: boundaryExpansionLossy || stabilized.lossy,
  };
}

function collectOverlappingSecretMatches(
  input: string,
  compiled: CompiledSecrets,
): SecretMatch[] {
  if (input.length < compiled.minLen) return [];
  const matches: SecretMatch[] = [];
  for (const [value, name] of compiled.valueToName.entries()) {
    let start = input.indexOf(value);
    while (start >= 0) {
      matches.push({ start, end: start + value.length, name });
      start = input.indexOf(value, start + 1);
    }
  }
  return matches.sort((a, b) => (
    a.start - b.start || (b.end - b.start) - (a.end - a.start)
  ));
}

function selectNonOverlappingSecretMatches(matches: SecretMatch[]): SecretMatch[] {
  const selected: SecretMatch[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    selected.push(match);
    cursor = match.end;
  }
  return selected;
}

function stabilizeRedactedString(
  input: string,
  compiled: CompiledSecrets,
): SecretStringRedactionResult {
  let current = input;
  let lossy = false;
  const seen = new Set<string>();
  for (let attempt = 0; attempt <= compiled.pairs.length; attempt++) {
    const remaining = findActionableSecretMatch(current, compiled);
    if (!remaining) return { value: current, lossy };
    const next = `\${SECRET:${remaining.name}}`;
    if (next === current || seen.has(next)) return { value: '', lossy: true };
    seen.add(current);
    current = next;
    lossy = true;
  }
  return { value: '', lossy: true };
}

function findActionableSecretMatch(
  input: string,
  compiled: CompiledSecrets,
): SecretMatch | undefined {
  const secrets = collectOverlappingSecretMatches(input, compiled);
  if (secrets.length === 0) return undefined;
  const placeholders: ProtectedPlaceholder[] = [];
  SECRET_PLACEHOLDER_RE.lastIndex = 0;
  for (const match of input.matchAll(SECRET_PLACEHOLDER_RE)) {
    if (!compiled.names.has(match[1])) continue;
    const start = match.index ?? 0;
    placeholders.push({ start, end: start + match[0].length, token: match[0] });
  }

  let placeholderCursor = 0;
  for (const secret of secrets) {
    while (
      placeholderCursor < placeholders.length
      && placeholders[placeholderCursor].end <= secret.start
    ) {
      placeholderCursor++;
    }
    let internal = false;
    for (
      let index = placeholderCursor;
      index < placeholders.length && placeholders[index].start < secret.end;
      index++
    ) {
      const placeholder = placeholders[index];
      if (secret.start > placeholder.start && secret.end < placeholder.end) {
        internal = true;
        break;
      }
    }
    if (!internal) return secret;
  }
  return undefined;
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
  return redactSecretStringWithMetadata(input, store).value;
}

export function redactSecretStringWithMetadata(
  input: string,
  store?: SecretStore,
): SecretStringRedactionResult {
  const s = store ?? getSecretStore();
  if (s.size === 0) return { value: input, lossy: false };
  const compiled = compile(s);
  return redactStringWithMetadata(input, compiled);
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
