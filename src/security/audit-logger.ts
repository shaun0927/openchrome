/**
 * Audit Logger — structured JSONL record of every tool invocation.
 *
 * Each entry carries enough correlation metadata (requestId, tenantId, keyId,
 * sessionId, durationMs, status) to let an operator trace a single request
 * end-to-end across logs, metrics, and audit. Arg values are redacted via the
 * `observability/redaction` engine before writing, and an `argsHash` of the
 * canonicalised original payload is recorded for integrity checks.
 *
 * Legacy fallback (when OPENCHROME_AUDIT_EXTENDED=false) preserves the
 * original `{timestamp, tool, domain, sessionId, args_summary}` shape so
 * downstream consumers can migrate on their own cadence.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGlobalConfig } from '../config/global';
import { extractHostname } from '../utils/url-utils';
import {
  BUILTIN_REDACTION_CONFIG,
  loadRedactionConfig,
  redactArgs,
  type RedactionConfig,
} from '../observability/redaction';
import { currentRequestContext } from '../observability/request-id';

export interface AuditLogMeta {
  /** Correlation ID; falls back to the active RequestContext or `null`. */
  requestId?: string;
  /** Tenant identifier; defaults to `'unknown'` until B-1/B-3 land. */
  tenantId?: string;
  /** Hashed prefix of the authenticating API key, when available. */
  keyId?: string;
  /** Granted scopes for the authenticating principal, when available. */
  scopes?: readonly string[];
  /** `'success'` | `'error'` | `'aborted'` — mirrors the metric status label. */
  status?: 'success' | 'error' | 'aborted';
  durationMs?: number;
  /** Truthy when the call was externally aborted (B-2). */
  aborted?: boolean;
  /** Whether the call should count toward billing. Defaults to true unless status=error. */
  billable?: boolean;
  /** Error message when status === 'error'. Should not contain sensitive data. */
  errorMessage?: string;
}

const PLAINTEXT_KEY_PREFIX = 'oc_live_';

// Belt-and-braces: strip anything that looks like a plaintext API key from
// audit inputs. The store never emits these, but defensive redaction here
// prevents accidental leaks via caller-supplied args.
//
// Plaintext format: `oc_live_{tenantId}_{32 base62 chars}`. tenantId is
// operator-supplied and is NOT restricted to [A-Za-z0-9_] — hyphens, dots,
// and other characters are valid. Matching only `[A-Za-z0-9_]+` after the
// prefix would stop at the first hyphen and leak the remainder of the key.
// We therefore match greedily up to a JSON/log delimiter (whitespace, string
// quote, or backslash) so the entire plaintext is redacted regardless of
// the tenantId character set.
export function redactPlaintextKeys(value: string): string {
  if (!value.includes(PLAINTEXT_KEY_PREFIX)) return value;
  return value.replace(/oc_live_[^\s"'\\]+/g, '[REDACTED]');
}

interface LegacyAuditEntry {
  timestamp: string;
  tool: string;
  domain: string | null;
  sessionId: string;
  args_summary: string;
}

interface ExtendedAuditEntry {
  ts: string;
  requestId: string | null;
  tenantId: string;
  keyId: string | null;
  sessionId: string;
  tool: string;
  domain: string | null;
  status: NonNullable<AuditLogMeta['status']>;
  durationMs: number | null;
  aborted: boolean;
  billable: boolean;
  argsHash: string;
  args: Record<string, unknown>;
  scopes?: string[];
  errorMessage?: string;
}

const TENANT_UNKNOWN = 'unknown';

let logDirEnsured = false;
let cachedConfig: RedactionConfig | null = null;

function getLogPath(): string {
  const config = getGlobalConfig();
  return config.security?.audit_log_path ||
    path.join(os.homedir(), '.openchrome', 'audit.log');
}

function extractDomain(url?: string): string | null {
  if (!url) return null;
  return extractHostname(url) || null;
}

function isExtendedEnabled(): boolean {
  const raw = process.env.OPENCHROME_AUDIT_EXTENDED;
  if (raw === undefined) return true; // extended is default-on — legacy is opt-in rollback
  return raw !== 'false' && raw !== '0';
}

/**
 * Walk up from the compiled module's directory looking for a sibling
 * `config/audit-redaction.json`. This finds the config shipped inside the
 * installed package (e.g. `node_modules/openchrome-mcp/config/…`) regardless
 * of whether the build layout is `dist/security/…` or `dist/src/security/…`.
 */
function findPackageRelativeConfig(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'config', 'audit-redaction.json');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveRedactionConfig(): RedactionConfig {
  if (cachedConfig) return cachedConfig;
  const customPath = process.env.OPENCHROME_AUDIT_REDACTION_CONFIG;
  const candidates = [
    customPath,
    // Repo/dev path: works when running from the project root.
    path.resolve(process.cwd(), 'config', 'audit-redaction.json'),
    // Installed path: walk up from this module so `npm install`-ed consumers
    // still pick up the shipped per-tool rules (e.g. cookie `value` hashing).
    findPackageRelativeConfig(),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedConfig = loadRedactionConfig(p);
        return cachedConfig;
      }
    } catch {
      // ignore
    }
  }
  cachedConfig = BUILTIN_REDACTION_CONFIG;
  return cachedConfig;
}

const LEGACY_SENSITIVE_KEYS = ['password', 'cookie', 'token', 'secret', 'auth', 'credential', 'value', 'text'];

function isLegacySensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return LEGACY_SENSITIVE_KEYS.some((s) => lower.includes(s));
}

function summarizeArgsLegacy(args: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isLegacySensitiveKey(key)) {
      safe[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      const redacted = redactPlaintextKeys(value);
      safe[key] = redacted.length > 100 ? redacted.slice(0, 100) + '...' : redacted;
    } else {
      safe[key] = value;
    }
  }
  return redactPlaintextKeys(JSON.stringify(safe));
}

function ensureDir(logPath: string): boolean {
  if (logDirEnsured) return true;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logDirEnsured = true;
    return true;
  } catch {
    return false;
  }
}

function appendLine(logPath: string, line: string): void {
  fs.appendFile(logPath, line, (err) => {
    if (err) console.error('[audit-logger] write failed:', err.code);
  });
}

/**
 * Log a tool invocation. `meta` carries the extended correlation fields; any
 * field left undefined falls back to the active request context (for
 * `requestId`/`tenantId`) or a safe default.
 */
export function logAuditEntry(
  tool: string,
  sessionId: string,
  args: Record<string, unknown>,
  pageUrl?: string,
  meta: AuditLogMeta = {},
): void {
  const config = getGlobalConfig();
  if (!config.security?.audit_log) return; // disabled by default

  const logPath = getLogPath();
  if (!ensureDir(logPath)) return;

  if (!isExtendedEnabled()) {
    const legacy: LegacyAuditEntry = {
      timestamp: new Date().toISOString(),
      tool,
      domain: extractDomain(pageUrl || (args.url as string | undefined)),
      sessionId,
      args_summary: summarizeArgsLegacy(args),
    };
    appendLine(logPath, JSON.stringify(legacy) + '\n');
    return;
  }

  const ctx = currentRequestContext();
  const cfg = resolveRedactionConfig();
  const { redacted, argsHash } = redactArgs(tool, args, cfg);
  const status = meta.status ?? 'success';

  const entry: ExtendedAuditEntry = {
    ts: new Date().toISOString(),
    requestId: meta.requestId ?? ctx?.requestId ?? null,
    tenantId: meta.tenantId ?? ctx?.tenantId ?? TENANT_UNKNOWN,
    keyId: meta.keyId ?? ctx?.keyId ?? null,
    sessionId,
    tool,
    domain: extractDomain(pageUrl || (args.url as string | undefined)),
    status,
    durationMs: typeof meta.durationMs === 'number' ? Math.round(meta.durationMs) : null,
    aborted: meta.aborted ?? false,
    billable: meta.billable ?? (status !== 'error'),
    argsHash,
    args: redacted,
  };
  if (meta.scopes && meta.scopes.length > 0) entry.scopes = [...meta.scopes];
  if (meta.errorMessage) entry.errorMessage = meta.errorMessage;

  appendLine(logPath, JSON.stringify(entry) + '\n');
}

/** Test hook — reset caches between tests. */
export function __resetAuditLoggerCachesForTests(): void {
  cachedConfig = null;
  logDirEnsured = false;
}
