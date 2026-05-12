/**
 * Secret loader (#834)
 *
 * Parses a dotenv-format file into an immutable `SecretStore`. The format is
 * intentionally narrow:
 *   • UTF-8 text, one secret per line, `KEY=value`.
 *   • Blank lines and lines beginning with `#` are ignored.
 *   • A trailing `# comment` on a value line is NOT stripped (treated as part
 *     of the value) to preserve secrets that legitimately contain `#`.
 *   • Single- or double-quoted values are unquoted; the quotes themselves are
 *     not part of the secret. No shell-style interpolation or command
 *     substitution is performed (P3: no exec surface).
 *   • Duplicate keys override (last write wins) but emit a warning.
 *   • Keys must match /^[A-Z_][A-Z0-9_]*$/i and be non-empty.
 *
 * Errors are reported with the 1-based source line number so operators can
 * fix the file quickly.
 */

import * as fs from 'fs';

/** Hard cap on the number of loaded secrets. Documented in docs/security.md. */
export const MAX_SECRETS = 100;

export interface SecretStore {
  /** Number of loaded secrets. */
  readonly size: number;
  /** Lookup by name; returns undefined if not present. */
  get(name: string): string | undefined;
  /** Whether a name is loaded. */
  has(name: string): boolean;
  /** Iterate over name/value pairs (for redactor / benchmark). */
  entries(): IterableIterator<[string, string]>;
  /** Iterate over values only (for redactor). */
  values(): IterableIterator<string>;
  /** Iterate over names only. */
  names(): IterableIterator<string>;
}

export class SecretLoadError extends Error {
  readonly code = 'SECRET_LOAD_ERROR';
  readonly line: number;
  constructor(message: string, line: number) {
    super(`secrets:${line}: ${message}`);
    this.name = 'SecretLoadError';
    this.line = line;
  }
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a dotenv-format string. Pure (no I/O) so callers can test it.
 * Throws `SecretLoadError` with the 1-based source line on the first
 * malformed line.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Tolerate BOM at the very start.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // Normalize CRLF, then split.
  const lines = stripped.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    // Strip leading/trailing whitespace for the empty/comment check only;
    // the value side preserves its own internal whitespace.
    const stripL = raw.replace(/^\s+/, '');
    if (stripL.length === 0) continue;
    if (stripL.startsWith('#')) continue;

    const eq = stripL.indexOf('=');
    if (eq < 0) {
      // Do NOT include the raw line content — a malformed line like
      // `MY_PASSWORD hunter2` (missing `=`) would otherwise echo a partial
      // secret into the startup log (P2 finding on PR #939).
      throw new SecretLoadError('missing "=" — check line syntax', lineNo);
    }
    const key = stripL.slice(0, eq).trimEnd();
    if (key.length === 0) {
      throw new SecretLoadError('empty key', lineNo);
    }
    if (!KEY_RE.test(key)) {
      throw new SecretLoadError(
        `invalid key "${key}" (must match /^[A-Za-z_][A-Za-z0-9_]*$/)`,
        lineNo,
      );
    }
    let value = stripL.slice(eq + 1);
    // Strip leading spaces only — trailing whitespace may be part of the
    // value (rare but legitimate for some HMAC seeds).
    value = value.replace(/^[ \t]+/, '');
    // Unquote if fully quoted.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (out.has(key)) {
      console.error(`[secrets] duplicate key "${key}" on line ${lineNo}; overriding`);
    }
    out.set(key, value);
    if (out.size > MAX_SECRETS) {
      throw new SecretLoadError(
        `too many secrets (max ${MAX_SECRETS}); reduce file size`,
        lineNo,
      );
    }
  }
  return out;
}

/** Construct a `SecretStore` from a parsed map. The map is copied. */
export function makeSecretStore(initial: Map<string, string>): SecretStore {
  const map = new Map(initial);
  return {
    get size() {
      return map.size;
    },
    get(name: string): string | undefined {
      return map.get(name);
    },
    has(name: string): boolean {
      return map.has(name);
    },
    entries() {
      return map.entries();
    },
    values() {
      return map.values();
    },
    names() {
      return map.keys();
    },
  };
}

/** An empty store (used as the default singleton when --secrets is unset). */
export const EMPTY_SECRET_STORE: SecretStore = makeSecretStore(new Map());

/**
 * Load a secrets file from disk. Throws `SecretLoadError` on any parse
 * failure with the 1-based source line, or rethrows the underlying fs error
 * (ENOENT, EACCES) on I/O failure.
 */
export function loadSecretsFromFile(filePath: string): SecretStore {
  const text = fs.readFileSync(filePath, 'utf8');
  const map = parseDotenv(text);
  return makeSecretStore(map);
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------
//
// The MCP server keeps a single SecretStore for the lifetime of the process
// (loaded once at startup from `--secrets <path>` in `src/index.ts`). The
// substitution and redaction layers reach for this via `getSecretStore()`.

let globalStore: SecretStore = EMPTY_SECRET_STORE;

/** Get the process-wide secret store (empty if `--secrets` was not passed). */
export function getSecretStore(): SecretStore {
  return globalStore;
}

/**
 * Replace the process-wide secret store. Called once from `src/index.ts`
 * after parsing `--secrets`. Subsequent calls are permitted (tests reset
 * via `setSecretStore(EMPTY_SECRET_STORE)`) but emit a warning to surface
 * accidental re-loads in production.
 */
export function setSecretStore(store: SecretStore): void {
  if (globalStore !== EMPTY_SECRET_STORE && store !== EMPTY_SECRET_STORE) {
    console.error('[secrets] secret store already loaded; replacing');
  }
  globalStore = store;
}
