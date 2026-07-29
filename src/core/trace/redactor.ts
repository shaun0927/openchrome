/**
 * Credential redactor for captured trace events.
 *
 * The audit-log redactor at `src/observability/redaction.ts` operates on
 * tool-call args (a structured object the harness controls). Trace events,
 * by contrast, contain CDP payloads and network bodies sourced from the
 * remote page — they need a different class of scrubbing focused on raw
 * text patterns (`Authorization` headers, JWT-like tokens, `password=` URL
 * params, AWS access keys, …).
 *
 * Rules:
 *   • Header fields whose name matches a sensitive list (case-insensitive)
 *     have their value replaced with `[REDACTED]`.
 *   • String values everywhere in the event tree are scanned and any match
 *     of a credential pattern is replaced with `[REDACTED]`.
 *   • Object keys whose name matches the sensitive list have their value
 *     replaced with `[REDACTED]`, regardless of value shape.
 *
 * The original input is never mutated. Output is a JSON-clone.
 */

export const REDACTED = '[REDACTED]';

/**
 * Explicit allow-list of keys introduced by issue #844 (`TraceTarget`
 * envelope written under `args.target`). None of these are sensitive — the
 * uid is opaque and synthetic, the backendNodeId is a Chrome-internal
 * counter, and the loaderId is a navigation epoch identifier. We document
 * the non-redaction decision here so a future audit does not need to
 * re-derive the rationale from the absence of a rule.
 *
 * The redactor's `isSensitiveKey` check uses substring containment against
 * `SENSITIVE_KEY_NAMES`; none of these three keys match any entry on that
 * list, so they pass through unchanged today. The constant exists so a
 * regression test can pin the contract.
 */
export const TRACE_TARGET_ALLOWLIST = ['nodeRef', 'backendNodeId', 'loaderId'] as const;

const VAULT_LITERAL_REDACTIONS = new Map<string, string>();

export function registerVaultTraceRedaction(name: string, plaintext: string): void {
  if (!name || !plaintext) return;
  VAULT_LITERAL_REDACTIONS.set(plaintext, `<vault:${name}>`);
}

export function clearVaultTraceRedactionsForTest(): void {
  VAULT_LITERAL_REDACTIONS.clear();
}

const SENSITIVE_KEY_NAMES = [
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
  'creditcard',
  'card_number',
  'ssn',
  'social_security',
  'private_key',
];

/** Header name set used when scrubbing CDP request/response headers. */
const SENSITIVE_HEADER_NAMES = new Set(
  ['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key'].map((s) =>
    s.toLowerCase(),
  ),
);

/**
 * Replay-telemetry fields allow-list (#875). These keys are emitted by
 * `oc_skill_replay` per-step telemetry and contain only non-sensitive
 * descriptors (skill identifiers, indices, resolution strategy names,
 * elapsed milliseconds, ok flag). Listed explicitly here so future audits of
 * `SENSITIVE_KEY_NAMES` know these fields are intentionally NOT redacted —
 * they must round-trip verbatim for the curator promote-pass signal.
 *
 *   skill_id, step_index, resolved_via, selector_attempts, elapsed_ms, ok
 *
 * No code change is required: none of the names overlap with
 * `SENSITIVE_KEY_NAMES` or any credential pattern. This comment is the
 * contract anchor.
 */

/** Patterns scanned in every string-typed value across the event tree. */
const CREDENTIAL_PATTERNS: { name: string; re: RegExp }[] = [
  // JWT — three base64url segments separated by dots
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // AWS Access Key ID
  { name: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Authorization Bearer / Basic / Token (only the credential portion).
  // HTTP scheme tokens are case-insensitive (`bearer` is just as valid as
  // `Bearer`), so match without case sensitivity to catch lowercase forms
  // that show up in raw network/body captures. The match's first capture
  // group preserves the original-case scheme name so the replacement
  // (`<scheme> [REDACTED]`) reads naturally for the operator.
  { name: 'auth_scheme', re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9+/=._-]{8,}/gi },
  // Generic high-entropy token: 32+ hex chars
  { name: 'hex_token', re: /\b[a-fA-F0-9]{32,}\b/g },
  // SSN (US): 3-2-4 digits
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // URL-encoded credential params. Match credential-bearing suffixes so
  // OAuth-style names such as `access_token`, `oauth_token`, and
  // `client_secret` are covered without treating benign names such as
  // `token_type` as credentials.
  {
    name: 'url_credential_param',
    re: /\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token)|api[_-]?key|apikey|access[_-]?key|credit[_-]?card|ssn)=([^\s&;"'<>]+)/gi,
  },
];

const URL_SCHEME_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\//g;
const URL_TERMINATOR_PATTERN = /[\s"'<>]/;
const ENCODED_URL_CANDIDATE_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*%3A%2F%2F[^\s&;"'<>]+/gi;

/**
 * Redact URL userinfo using WHATWG parsing so raw `@` characters inside a
 * password cannot be mistaken for the authority delimiter. The parser
 * validates that the candidate actually carries credentials; reconstruction
 * uses the final authority `@` so the original host/path/query spelling stays
 * intact instead of being canonicalized by URL serialization.
 */
function redactRawUrlUserinfo(value: string): string {
  const starts = Array.from(value.matchAll(URL_SCHEME_PATTERN), (match) => match.index);
  let out = value;

  // Process from right to left so an outer URL cannot consume and hide a
  // credentialed URL embedded in one of its query values.
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index];
    const relativeEnd = out.slice(start).search(URL_TERMINATOR_PATTERN);
    const end = relativeEnd < 0 ? out.length : start + relativeEnd;
    const candidate = out.slice(start, end);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (!parsed.username && !parsed.password) continue;

    const schemeEnd = candidate.indexOf('//') + 2;
    const authoritySuffix = candidate.slice(schemeEnd).search(/[/?#]/);
    const authorityEnd = authoritySuffix < 0
      ? candidate.length
      : schemeEnd + authoritySuffix;
    const userinfoEnd = candidate.lastIndexOf('@', authorityEnd - 1);
    if (userinfoEnd < schemeEnd) continue;

    const redacted = `${candidate.slice(0, schemeEnd)}${REDACTED}@${candidate.slice(userinfoEnd + 1)}`;
    out = `${out.slice(0, start)}${redacted}${out.slice(end)}`;
  }

  return out;
}

function redactEncodedUrlUserinfo(value: string): string {
  return value.replace(ENCODED_URL_CANDIDATE_PATTERN, (candidate) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return candidate;
    }
    const redacted = redactRawUrlUserinfo(decoded);
    return redacted === decoded ? candidate : encodeURIComponent(redacted);
  });
}

function redactUrlUserinfo(value: string): string {
  return redactEncodedUrlUserinfo(redactRawUrlUserinfo(value));
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_NAMES.some((s) => lower.includes(s));
}

/**
 * Scrub a single string. Replaces matched credential substrings with
 * `[REDACTED]`. URL-credential params keep the param name and replace only
 * the value: `password=hunter2` → `password=[REDACTED]`.
 */
export function scrubString(value: string): string {
  let out = redactUrlUserinfo(value);
  for (const [plaintext, token] of VAULT_LITERAL_REDACTIONS) {
    out = out.split(plaintext).join(token);
  }
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (name === 'url_credential_param') {
      out = out.replace(re, (_m, p1: string) => `${p1}=${REDACTED}`);
    } else if (name === 'auth_scheme') {
      out = out.replace(re, (_m, p1: string) => `${p1} ${REDACTED}`);
    } else {
      out = out.replace(re, REDACTED);
    }
  }
  return out;
}


/**
 * Redact JavaScript predicate source before it is persisted in trace-like
 * telemetry. Predicate strings often quote cookies, bearer tokens, or fixture
 * secrets inline; generic pattern redaction handles known token shapes, while
 * the cookie/storage guard below redacts quoted literals when the predicate is
 * explicitly reading browser credential stores.
 */
export function redactPredicateSource(value: string): string {
  let out = scrubString(value);
  if (/document\.cookie|\bcookie\b|localStorage|sessionStorage/i.test(out)) {
    out = out.replace(/(['"])([^'"]{4,})\1/g, (_m, quote: string) => `${quote}${REDACTED}${quote}`);
  }
  return out;
}
function redactWaitForArgs(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return walk(value);
  const args = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'value' && args.type === 'function' && typeof v === 'string') {
      out[k] = redactPredicateSource(v);
    } else {
      out[k] = walk(v);
    }
  }
  return out;
}

/**
 * Redact an HTTP-header bag (record or array-of-`{name, value}`). Sensitive
 * header values are replaced wholesale; non-sensitive headers still pass
 * through `scrubString` so an `X-Custom: Bearer abc` slips through to the
 * pattern scrub.
 */
function redactHeaders(headers: unknown): unknown {
  if (!headers) return headers;

  if (Array.isArray(headers)) {
    return headers.map((h) => {
      if (h && typeof h === 'object') {
        const entry = h as Record<string, unknown>;
        const name = typeof entry.name === 'string' ? entry.name : '';
        const value = typeof entry.value === 'string' ? entry.value : entry.value;
        if (name && SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
          return { ...entry, value: REDACTED };
        }
        return {
          ...entry,
          value: typeof value === 'string' ? scrubString(value) : value,
        };
      }
      return h;
    });
  }

  if (typeof headers === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else if (typeof v === 'string') {
        out[k] = scrubString(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  return headers;
}

/**
 * Recursive walker: scrubs string values, redacts sensitive keys, recurses
 * into arrays/objects. `headers` keys get the dedicated header treatment.
 *
 * `siblingName` carries a `{name, value}` form-field shape's `name` field
 * down so the `value` sibling can be redacted when `name` is sensitive.
 * This mirrors how CDP `Page.javascriptDialogOpening` and parsed form-data
 * events arrive in the wire protocol.
 */
function walk(value: unknown, siblingName?: string): unknown {
  if (typeof value === 'string') {
    if (siblingName && isSensitiveKey(siblingName)) return REDACTED;
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const toolName = typeof obj.tool === 'string' ? obj.tool : typeof obj.name === 'string' ? obj.name : typeof obj.toolName === 'string' ? obj.toolName : undefined;
    if (toolName === 'wait_for') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if ((k === 'args' || k === 'arguments') && v && typeof v === 'object') {
          out[k] = redactWaitForArgs(v);
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    // Detect form-field shape: an object with both `name` (string) and `value`
    // keys is treated as a key-value pair where `name` controls `value`.
    const formFieldName =
      typeof obj.name === 'string' && 'value' in obj ? (obj.name as string) : undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const keyLower = k.toLowerCase();
      if (keyLower === 'headers' || keyLower === 'response_headers' || keyLower === 'request_headers') {
        out[k] = redactHeaders(v);
        continue;
      }
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      // Form-field sibling rule: when this object is a {name, value} pair
      // and name is sensitive, redact value wholesale.
      if (k === 'value' && formFieldName && isSensitiveKey(formFieldName)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}

/**
 * Top-level entry: redact a captured trace event's `body`. The wrapper
 * envelope (`ts`, `seq`, `kind`) is preserved as-is.
 *
 * Composition (#834): the body is first walked through the credential
 * pattern matcher (this file), then through the loaded-secrets redactor
 * (`src/core/secrets/redactor.ts`). The secrets pass is a no-op when
 * `--secrets` was not provided.
 */
export function redactTraceEvent<T extends { body: unknown }>(event: T): T {
  // Lazy import keeps the credential-pattern redactor self-contained for
  // callers that pull the trace module in isolation (no implicit
  // dependency cycle with the secrets module's own redactor walk).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { redactSecrets } = require('../secrets/redactor') as typeof import('../secrets/redactor');
  return { ...event, body: redactSecrets(walk(event.body)) } as T;
}

/** Convenience for tests: redact an arbitrary value tree. */
export function redactValue(value: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { redactSecrets } = require('../secrets/redactor') as typeof import('../secrets/redactor');
  return redactSecrets(walk(value));
}
