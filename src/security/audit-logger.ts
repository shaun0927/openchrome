/**
 * Audit Logger - Logs tool invocations for security review
 * Writes structured JSONL to ~/.openchrome/audit.log
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGlobalConfig } from '../config/global';

interface AuditEntry {
  timestamp: string;      // ISO 8601
  tool: string;           // tool name
  domain: string | null;  // extracted from page URL, null if N/A
  sessionId: string;
  args_summary: string;   // brief summary, no sensitive data
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
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const SENSITIVE_KEYS = ['password', 'cookie', 'token', 'secret', 'auth', 'credential', 'value', 'text', 'content'];

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
    } else if (typeof value === 'string' && value.length > 100) {
      safe[key] = value.slice(0, 100) + '...';
    } else {
      safe[key] = value;
    }
  }
  return JSON.stringify(safe);
}

export function logAuditEntry(tool: string, sessionId: string, args: Record<string, unknown>, pageUrl?: string): void {
  const config = getGlobalConfig();
  if (!config.security?.audit_log) return; // Disabled by default

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    tool,
    domain: extractDomain(pageUrl || (args.url as string)),
    sessionId,
    args_summary: summarizeArgs(args),
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
