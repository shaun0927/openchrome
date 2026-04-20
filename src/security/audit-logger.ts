/**
 * Audit Logger - Logs tool invocations for security review
 * Writes structured JSONL to ~/.openchrome/audit.log
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGlobalConfig } from '../config/global';
import { extractHostname } from '../utils/url-utils';

interface AuditEntry {
  timestamp: string;      // ISO 8601
  tool: string;           // tool name
  domain: string | null;  // extracted from page URL, null if N/A
  sessionId: string;
  args_summary: string;   // brief summary, no sensitive data
  keyId?: string;         // api-key id (sha256-derived); never plaintext
  tenantId?: string;      // tenant owner of the key
  scopes?: string[];      // scopes granted by the key
}

export interface AuditEntryExtras {
  keyId?: string;
  tenantId?: string;
  scopes?: readonly string[];
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

let logDirEnsured = false;

// Get log file path
function getLogPath(): string {
  const config = getGlobalConfig();
  return config.security?.audit_log_path ||
    path.join(os.homedir(), '.openchrome', 'audit.log');
}

// Extract domain from URL safely
function extractDomain(url?: string): string | null {
  if (!url) return null;
  return extractHostname(url) || null;
}

const SENSITIVE_KEYS = ['password', 'cookie', 'token', 'secret', 'auth', 'credential', 'value', 'text'];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some(s => lower.includes(s));
}

// Summarize args (redact sensitive values)
function summarizeArgs(args: Record<string, unknown>): string {
  // Include keys like tabId, url, action but redact values of sensitive keys
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveKey(key)) {
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

export function logAuditEntry(
  tool: string,
  sessionId: string,
  args: Record<string, unknown>,
  pageUrl?: string,
  extras?: AuditEntryExtras,
): void {
  const config = getGlobalConfig();
  if (!config.security?.audit_log) return; // Disabled by default

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    tool,
    domain: extractDomain(pageUrl || (args.url as string)),
    sessionId,
    args_summary: summarizeArgs(args),
    ...(extras?.keyId ? { keyId: extras.keyId } : {}),
    ...(extras?.tenantId ? { tenantId: extras.tenantId } : {}),
    ...(extras?.scopes ? { scopes: [...extras.scopes] } : {}),
  };

  const logPath = getLogPath();
  const logDir = path.dirname(logPath);

  // Ensure directory exists (first time only)
  if (!logDirEnsured) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      logDirEnsured = true;
    } catch {
      return; // Non-fatal
    }
  }

  // Non-blocking append
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(logPath, line, (err) => { if (err) console.error('[audit-logger] write failed:', err.code); });
}
