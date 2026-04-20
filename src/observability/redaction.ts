/**
 * Args redaction engine for audit log entries.
 *
 * Redaction is applied in two layers:
 *   1. Per-tool rules from `config/audit-redaction.json` pin known sensitive
 *      fields (for example `cookies.set.value` → hash).
 *   2. A heuristic pass redacts values whose field name looks sensitive
 *      (`password`, `token`, …) anywhere in the args tree.
 *
 * The output is a deep-cloned plain object safe for JSON serialisation.
 * Original args are never mutated.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type RedactionMode = 'redact' | 'hash' | 'truncate' | 'redactIfSensitiveName';

export interface RedactionRule {
  /** Dot-path into args; `[*]` matches any array index. */
  path: string;
  mode: RedactionMode;
  /** For `truncate`: keep first N UTF-8 bytes of the serialised value. */
  maxBytes?: number;
}

export interface RedactionConfig {
  defaultSensitiveFieldNames: string[];
  tools: Record<string, RedactionRule[]>;
}

export const REDACTED = '[REDACTED]';

const DEFAULT_TRUNCATE_MAX_BYTES = 200;

/**
 * Built-in minimum policy used when no config file is present. Keeps a safe
 * fallback so that audit log entries never carry raw password/token values
 * just because the operator forgot to ship the config file.
 */
export const BUILTIN_REDACTION_CONFIG: RedactionConfig = {
  defaultSensitiveFieldNames: [
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'authorization',
    'auth',
    'api_key',
    'apikey',
    'access_key',
    'refresh_token',
    'id_token',
    'session_token',
    'cookie',
    'set-cookie',
    'credit_card',
    'ssn',
    'private_key',
  ],
  tools: {},
};

export function loadRedactionConfig(filePath: string): RedactionConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RedactionConfig>;
    const sensitive = Array.isArray(parsed.defaultSensitiveFieldNames)
      ? parsed.defaultSensitiveFieldNames.map((s) => String(s).toLowerCase())
      : BUILTIN_REDACTION_CONFIG.defaultSensitiveFieldNames;
    const tools = (parsed.tools && typeof parsed.tools === 'object') ? parsed.tools : {};
    return { defaultSensitiveFieldNames: sensitive, tools };
  } catch {
    return BUILTIN_REDACTION_CONFIG;
  }
}

/**
 * Resolve the default config path. Prefer the repo-local `config/` tree; fall
 * back to the built-in policy if the file is missing.
 */
export function defaultRedactionConfigPath(): string {
  return path.resolve(process.cwd(), 'config', 'audit-redaction.json');
}

function sha256(value: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

/**
 * Stable JSON stringification with sorted object keys, so that equivalent
 * payloads produced by different callers hash identically. Arrays preserve
 * order. Cycles are not expected in audit args.
 */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  // Drop keys whose value is `undefined`, matching JSON.stringify's behaviour
  // so that `{a:1, b:undefined}` and `{a:1}` produce the same hash.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * multi-byte code point. JS string `.length` and `.slice()` count UTF-16 code
 * units, which can underestimate byte size for non-ASCII payloads.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  const chars: string[] = [];
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    chars.push(ch);
    bytes += chBytes;
  }
  return chars.join('');
}

/**
 * Tokenise an identifier into lowercase word tokens. Splits on
 * camelCase boundaries and any non-alphanumeric separator, so
 * `apiKey`, `api_key`, `api-key` all yield `['api', 'key']`.
 */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Token-aware sensitivity check. A sensitive entry matches when its
 * own tokens appear as a contiguous run in the field name's tokens.
 * This avoids false positives like `author` ⊃ `auth` or
 * `authentication_method` ⊃ `auth` that a naive substring check
 * would produce.
 */
function isSensitiveName(name: string, sensitiveNames: string[]): boolean {
  const tokens = tokenize(name);
  if (tokens.length === 0) return false;
  const joined = ' ' + tokens.join(' ') + ' ';
  for (const sensitive of sensitiveNames) {
    const sensTokens = tokenize(sensitive);
    if (sensTokens.length === 0) continue;
    if (joined.includes(' ' + sensTokens.join(' ') + ' ')) return true;
  }
  return false;
}

function applyMode(value: unknown, mode: RedactionMode, opts: { maxBytes?: number; sensitiveNames: string[]; name?: string; siblingName?: unknown }): unknown {
  switch (mode) {
    case 'redact':
      return REDACTED;
    case 'hash':
      return sha256(stringify(value));
    case 'truncate': {
      const text = stringify(value);
      const max = opts.maxBytes ?? DEFAULT_TRUNCATE_MAX_BYTES;
      if (Buffer.byteLength(text, 'utf8') <= max) return text;
      return { preview: truncateUtf8(text, max), hash: sha256(text), truncated: true };
    }
    case 'redactIfSensitiveName': {
      // Check the containing field name first (for rules like {path: 'password'})
      if (opts.name && isSensitiveName(opts.name, opts.sensitiveNames)) {
        return REDACTED;
      }
      // Then check sibling `name` when the rule targets a `{name, value}` shape
      // (form fields: {name: 'password', value: 'hunter2'}).
      if (typeof opts.siblingName === 'string' && isSensitiveName(opts.siblingName, opts.sensitiveNames)) {
        return REDACTED;
      }
      return value;
    }
  }
}

/**
 * Split a dot-path like `cookies[*].value` into segments. `[*]` and `[n]` are
 * treated as array wildcards / indexes.
 */
function splitPath(p: string): Array<{ key: string; index?: number | '*' }> {
  // Normalise `a[0]` into `a.0` while remembering wildcard.
  const parts = p
    .replace(/\[(\*|\d+)\]/g, (_m, g1) => '.' + g1)
    .split('.')
    .filter(Boolean);
  return parts.map((seg) => {
    if (seg === '*') return { key: '', index: '*' as const };
    if (/^\d+$/.test(seg)) return { key: '', index: Number(seg) };
    return { key: seg };
  });
}

function applyRuleAt(target: Record<string, unknown> | unknown[], segments: Array<{ key: string; index?: number | '*' }>, rule: RedactionRule, cfg: RedactionConfig, siblingName?: unknown): void {
  if (segments.length === 0) return;
  const [seg, ...rest] = segments;

  if (seg.index !== undefined) {
    if (!Array.isArray(target)) return;
    const indices: number[] = seg.index === '*'
      ? target.map((_v, i) => i)
      : (seg.index < target.length ? [seg.index] : []);
    for (const i of indices) {
      if (rest.length === 0) {
        target[i] = applyMode(target[i], rule.mode, {
          maxBytes: rule.maxBytes,
          sensitiveNames: cfg.defaultSensitiveFieldNames,
        });
      } else if (target[i] && typeof target[i] === 'object') {
        // Recurse, but stash sibling 'name' for `{name, value}` shapes so
        // redactIfSensitiveName can consult the form field's declared name.
        const child = target[i] as Record<string, unknown> | unknown[];
        const siblingName = (!Array.isArray(child) && 'name' in child)
          ? (child as Record<string, unknown>).name
          : undefined;
        applyRuleAt(child, rest, rule, cfg, siblingName);
      }
    }
    return;
  }

  if (Array.isArray(target) || !target || typeof target !== 'object') return;
  const obj = target as Record<string, unknown>;
  if (!(seg.key in obj)) return;

  if (rest.length === 0) {
    obj[seg.key] = applyMode(obj[seg.key], rule.mode, {
      maxBytes: rule.maxBytes,
      sensitiveNames: cfg.defaultSensitiveFieldNames,
      name: seg.key,
      siblingName,
    });
    return;
  }

  const next = obj[seg.key];
  if (next && typeof next === 'object') {
    applyRuleAt(next as Record<string, unknown> | unknown[], rest, rule, cfg);
  }
}

function walkAndRedactByName(value: unknown, cfg: RedactionConfig): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walkAndRedactByName(v, cfg));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Detect `{name, value}` form-field shape: when `name` is a sensitive
    // identifier, treat the sibling `value` as a secret. This catches form
    // payloads even when no per-tool rule is configured (e.g. when the config
    // file is missing and we fall back to the built-in policy).
    const looksLikeFormField =
      typeof obj.name === 'string' &&
      'value' in obj &&
      isSensitiveName(obj.name as string, cfg.defaultSensitiveFieldNames);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (isSensitiveName(k, cfg.defaultSensitiveFieldNames)) {
        out[k] = REDACTED;
      } else if (looksLikeFormField && k === 'value') {
        out[k] = REDACTED;
      } else {
        out[k] = walkAndRedactByName(v, cfg);
      }
    }
    return out;
  }
  return value;
}

/** Deep clone via JSON; safe because audit args are always JSON-serialisable. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Redact a tool-call args object. Returns a new object — original is not
 * mutated. Also returns a sha256 of the canonicalised original args for audit
 * integrity.
 */
export function redactArgs(
  toolName: string,
  args: Record<string, unknown>,
  cfg: RedactionConfig = BUILTIN_REDACTION_CONFIG,
): { redacted: Record<string, unknown>; argsHash: string } {
  const clone = deepClone(args);
  const rules = cfg.tools[toolName] || [];
  for (const rule of rules) {
    const segments = splitPath(rule.path);
    applyRuleAt(clone as Record<string, unknown>, segments, rule, cfg);
  }
  const afterHeuristic = walkAndRedactByName(clone, cfg) as Record<string, unknown>;
  // Hash the canonicalised original args so equivalent payloads with different
  // key insertion order produce the same hash (stable integrity / dedup).
  const argsHash = sha256(canonicalStringify(args));
  return { redacted: afterHeuristic, argsHash };
}
