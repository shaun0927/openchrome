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
  /** For `truncate`: keep first N bytes of the serialised value. */
  maxBytes?: number;
}

export interface RedactionConfig {
  defaultSensitiveFieldNames: string[];
  tools: Record<string, RedactionRule[]>;
}

export const REDACTED = '[REDACTED]';

const DEFAULT_TRUNCATE_MAX_BYTES = 200;

/**
 * Built-in minimum policy used when no config file is present. Includes
 * per-tool rules for fields whose names (e.g. `value`, `text`, `code`) are
 * not in the heuristic sensitive-name list but are sensitive by virtue of
 * the containing tool — without these rules, raw cookie values or typed
 * text would end up in the audit log in cleartext.
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
  tools: {
    cookies: [
      { path: 'value', mode: 'hash' },
    ],
    'cookies.set': [
      { path: 'value', mode: 'hash' },
      { path: 'cookies[*].value', mode: 'hash' },
    ],
    fill_form: [
      { path: 'fields[*].value', mode: 'redactIfSensitiveName' },
    ],
    form_input: [
      { path: 'value', mode: 'redactIfSensitiveName' },
    ],
    type: [
      { path: 'text', mode: 'truncate', maxBytes: 200 },
    ],
    javascript_tool: [
      { path: 'code', mode: 'truncate', maxBytes: 200 },
    ],
    storage: [
      { path: 'value', mode: 'truncate', maxBytes: 200 },
    ],
  },
};

export function loadRedactionConfig(filePath: string): RedactionConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RedactionConfig>;
    const sensitive = Array.isArray(parsed.defaultSensitiveFieldNames)
      ? parsed.defaultSensitiveFieldNames.map((s) => String(s).toLowerCase())
      : BUILTIN_REDACTION_CONFIG.defaultSensitiveFieldNames;
    // Only keep tool entries whose rules are arrays; a malformed entry
    // (e.g. a single object) would otherwise crash `for...of` at runtime
    // and break the tool call the audit log is meant to record.
    const toolsIn = (parsed.tools && typeof parsed.tools === 'object')
      ? (parsed.tools as Record<string, unknown>)
      : {};
    const tools: Record<string, RedactionRule[]> = {};
    for (const [name, rules] of Object.entries(toolsIn)) {
      if (Array.isArray(rules)) {
        tools[name] = rules as RedactionRule[];
      } else {
        console.error(`[redaction] ignoring tool "${name}": rules must be an array, got ${typeof rules}`);
      }
    }
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

function isSensitiveName(name: string, sensitiveNames: string[]): boolean {
  const lower = name.toLowerCase();
  return sensitiveNames.some((s) => lower.includes(s));
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
      if (text.length <= max) return text;
      return { preview: text.slice(0, max), hash: sha256(text), truncated: true };
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
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveName(k, cfg.defaultSensitiveFieldNames)) {
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
  const rawRules = cfg.tools[toolName];
  // Defense in depth: tolerate a malformed config that somehow reached here
  // (e.g. programmatic construction bypassing loadRedactionConfig). A bad
  // audit config must never break the tool call itself.
  const rules: RedactionRule[] = Array.isArray(rawRules) ? rawRules : [];
  for (const rule of rules) {
    const segments = splitPath(rule.path);
    applyRuleAt(clone as Record<string, unknown>, segments, rule, cfg);
  }
  const afterHeuristic = walkAndRedactByName(clone, cfg) as Record<string, unknown>;
  const argsHash = sha256(stringify(args));
  return { redacted: afterHeuristic, argsHash };
}
