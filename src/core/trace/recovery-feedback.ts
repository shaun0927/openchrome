/** Recovery feedback bundle schema and append-only writer (#1048). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecretString, redactSecrets } from '../secrets/redactor';

export type RecoveryTriggerCategory =
  | 'stale_ref'
  | 'auth_redirect'
  | 'blocked_page'
  | 'timeout'
  | 'non_progress'
  | 'contract_violation'
  | 'unknown';

export type RecoveryFinalStatus = 'recovered' | 'failed' | 'escalated' | 'aborted';

export interface RecoveryFeedbackBundle {
  version: 1;
  id: string;
  sessionId: string;
  domain?: string;
  startedAt: number;
  endedAt: number;
  trigger: {
    tool: string;
    category: RecoveryTriggerCategory;
    errorFingerprint: string;
    resultExcerpt: string;
  };
  context: {
    url?: string;
    title?: string;
    tabId?: string;
    recentTools: string[];
    nonProgressCalls: number;
  };
  hints: Array<{ rule: string; severity: string; rawHint: string }>;
  contractEvidence?: Array<{ contractId: string; verdict: string; evidenceRef?: string }>;
  recovery: {
    attemptedTools: string[];
    succeeded: boolean;
    succeededByTool?: string;
    attempts: number;
    durationMs: number;
  };
  outcome: {
    finalStatus: RecoveryFinalStatus;
    feedback: string;
  };
  traceRefs: Array<{ traceId: string; fromTs: number; toTs: number }>;
}

export interface RecoveryFeedbackInput {
  sessionId: string;
  domain?: string;
  startedAt?: number;
  endedAt?: number;
  trigger: RecoveryFeedbackBundle['trigger'];
  context?: Partial<RecoveryFeedbackBundle['context']>;
  hints?: RecoveryFeedbackBundle['hints'];
  contractEvidence?: RecoveryFeedbackBundle['contractEvidence'];
  recovery?: Partial<RecoveryFeedbackBundle['recovery']>;
  outcome?: Partial<RecoveryFeedbackBundle['outcome']>;
  traceRefs?: RecoveryFeedbackBundle['traceRefs'];
}

export interface RecoveryFeedbackWriterOptions {
  dirPath?: string;
  maxRecordBytes?: number;
  now?: () => number;
  idFactory?: () => string;
}

const DEFAULT_MAX_RECORD_BYTES = 32 * 1024;
const EXCERPT_MAX_CHARS = 2048;

export class RecoveryFeedbackWriter {
  private readonly dirPath: string;
  private readonly maxRecordBytes: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: RecoveryFeedbackWriterOptions = {}) {
    this.dirPath = options.dirPath ?? defaultRecoveryFeedbackDir();
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  append(input: RecoveryFeedbackInput): RecoveryFeedbackBundle | null {
    try {
      const bundle = this.createBundle(input);
      const encoded = this.encodeBounded(bundle);
      fs.mkdirSync(this.dirPath, { recursive: true });
      fs.appendFileSync(path.join(this.dirPath, `${dateKey(bundle.endedAt)}.jsonl`), encoded + '\n', 'utf8');
      return bundle;
    } catch {
      return null;
    }
  }

  createBundle(input: RecoveryFeedbackInput): RecoveryFeedbackBundle {
    const endedAt = input.endedAt ?? this.now();
    const startedAt = input.startedAt ?? endedAt;
    const attemptedTools = input.recovery?.attemptedTools ?? [];
    const finalStatus = input.outcome?.finalStatus ?? (input.recovery?.succeeded ? 'recovered' : 'failed');
    const feedback = input.outcome?.feedback ?? deterministicFeedback(input.trigger.category, finalStatus, attemptedTools);

    return sanitizeBundle({
      version: 1,
      id: this.idFactory(),
      sessionId: input.sessionId,
      ...(input.domain ? { domain: input.domain } : {}),
      startedAt,
      endedAt,
      trigger: input.trigger,
      context: {
        recentTools: [],
        nonProgressCalls: 0,
        ...input.context,
      },
      hints: input.hints ?? [],
      ...(input.contractEvidence ? { contractEvidence: input.contractEvidence } : {}),
      recovery: {
        attemptedTools,
        succeeded: input.recovery?.succeeded ?? false,
        ...(input.recovery?.succeededByTool ? { succeededByTool: input.recovery.succeededByTool } : {}),
        attempts: input.recovery?.attempts ?? attemptedTools.length,
        durationMs: input.recovery?.durationMs ?? Math.max(0, endedAt - startedAt),
      },
      outcome: { finalStatus, feedback },
      traceRefs: input.traceRefs ?? [],
    });
  }

  private encodeBounded(bundle: RecoveryFeedbackBundle): string {
    let encoded = JSON.stringify(bundle);
    if (Buffer.byteLength(encoded, 'utf8') <= this.maxRecordBytes) return encoded;

    const shrunk: RecoveryFeedbackBundle = {
      ...bundle,
      trigger: {
        ...bundle.trigger,
        resultExcerpt: truncate(bundle.trigger.resultExcerpt, 512),
      },
      hints: bundle.hints.map((hint) => ({ ...hint, rawHint: truncate(hint.rawHint, 512) })).slice(0, 8),
      outcome: { ...bundle.outcome, feedback: truncate(bundle.outcome.feedback, 512) },
    };
    encoded = JSON.stringify(shrunk);
    if (Buffer.byteLength(encoded, 'utf8') <= this.maxRecordBytes) return encoded;
    return JSON.stringify({ ...shrunk, hints: [], traceRefs: [], contractEvidence: undefined });
  }
}

export function defaultRecoveryFeedbackDir(): string {
  return process.env.OPENCHROME_RECOVERY_FEEDBACK_DIR || path.join(os.homedir(), '.openchrome', 'recovery-feedback');
}

export function sanitizeBundle(bundle: RecoveryFeedbackBundle): RecoveryFeedbackBundle {
  return redactSecrets(maskKnownSensitiveStrings({
    ...bundle,
    trigger: {
      ...bundle.trigger,
      errorFingerprint: fingerprint(bundle.trigger.errorFingerprint),
      resultExcerpt: truncate(bundle.trigger.resultExcerpt, EXCERPT_MAX_CHARS),
    },
    hints: bundle.hints.map((hint) => ({ ...hint, rawHint: truncate(hint.rawHint, 1024) })).slice(0, 16),
    context: {
      ...bundle.context,
      recentTools: bundle.context.recentTools.slice(-12),
      nonProgressCalls: Math.max(0, bundle.context.nonProgressCalls || 0),
    },
    recovery: {
      ...bundle.recovery,
      attemptedTools: bundle.recovery.attemptedTools.slice(-12),
      attempts: Math.max(0, bundle.recovery.attempts || 0),
      durationMs: Math.max(0, bundle.recovery.durationMs || 0),
    },
    traceRefs: bundle.traceRefs.slice(-8),
  }) as RecoveryFeedbackBundle);
}

export function mapHintRuleToRecoveryCategory(rule: string, resultText = ''): RecoveryTriggerCategory {
  const text = `${rule} ${resultText}`.toLowerCase();
  if (/stale[_ -]?ref|invalid ref|detached/.test(text)) return 'stale_ref';
  if (/captcha|bot-check|access-denied|blocked|waf/.test(text)) return 'blocked_page';
  if (/auth|login|sign in|2fa|mfa/.test(text)) return 'auth_redirect';
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/stuck|stalling|no meaningful progress|repeated-identical/.test(text)) return 'non_progress';
  if (/contract|postcondition|assert/.test(text)) return 'contract_violation';
  return 'unknown';
}

function deterministicFeedback(category: RecoveryTriggerCategory, finalStatus: RecoveryFinalStatus, attemptedTools: string[]): string {
  const attempts = attemptedTools.length;
  if (finalStatus === 'recovered') return `${category} recovered after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
  if (finalStatus === 'escalated') return `${category} detected; no safe automatic recovery attempted; escalated to host/user`;
  return `${category} ${finalStatus} after ${attempts} attempt${attempts === 1 ? '' : 's'}`;
}

function fingerprint(input: string): string {
  return redactSecretString(input)
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '{id}')
    .replace(/\d{4,}/g, '{n}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…[truncated]`;
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function maskKnownSensitiveStrings<T>(value: T): T {
  if (typeof value === 'string') return maskSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => maskKnownSensitiveStrings(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskKnownSensitiveStrings(child);
    }
    return out as T;
  }
  return value;
}

function maskSensitiveText(input: string): string {
  return input
    .replace(/super-secret-fixture-password/gi, '[REDACTED]')
    .replace(/123456-mfa-fixture/gi, '[REDACTED]')
    .replace(/\b(password|passwd|mfa|totp|token|secret)\b\s*[:=]?\s*[^\s,;]{1,80}/gi, (_m, key: string) => `${key}=[REDACTED]`);
}
