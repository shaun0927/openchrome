/** Evidence-backed recovery policy learning. Advisory only. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RecoveryPolicyOutcome {
  failureFingerprint: string;
  domain?: string;
  triggerTool: string;
  recoveryTool: string;
  safetyClass: 'read_only' | 'reversible' | 'side_effect_possible';
  evidenceBacked: boolean;
  succeeded: boolean;
}

export interface RecoveryPolicyRecord {
  id: string;
  failureFingerprint: string;
  domain?: string;
  triggerTool: string;
  recoveryTool: string;
  safetyClass: RecoveryPolicyOutcome['safetyClass'];
  attempts: number;
  successes: number;
  failures: number;
  confidence: number;
  promoted: boolean;
  firstSeen: number;
  lastSeen: number;
}

interface PolicyStoreFile {
  version: number;
  updatedAt: number;
  policies: RecoveryPolicyRecord[];
}

export interface RecoveryPolicyLearnerOptions {
  filePath?: string;
  minAttempts?: number;
  minConfidence?: number;
  maxPolicies?: number;
}

export class RecoveryPolicyLearner {
  private readonly filePath: string;
  private readonly minAttempts: number;
  private readonly minConfidence: number;
  private readonly maxPolicies: number;
  private policies = new Map<string, RecoveryPolicyRecord>();

  constructor(options: RecoveryPolicyLearnerOptions = {}) {
    this.filePath = options.filePath ?? path.join(process.cwd(), '.openchrome', 'recovery', 'learned-policies.json');
    this.minAttempts = options.minAttempts ?? 3;
    this.minConfidence = options.minConfidence ?? 0.67;
    this.maxPolicies = options.maxPolicies ?? 500;
    this.load();
  }

  record(outcome: RecoveryPolicyOutcome): RecoveryPolicyRecord | null {
    if (!outcome.evidenceBacked) return null;
    if (!outcome.failureFingerprint || !outcome.triggerTool || !outcome.recoveryTool) return null;

    const key = policyKey(outcome);
    const now = Date.now();
    let record = this.policies.get(key);
    if (!record) {
      record = {
        id: key,
        failureFingerprint: outcome.failureFingerprint,
        domain: sanitizeDomain(outcome.domain),
        triggerTool: outcome.triggerTool,
        recoveryTool: outcome.recoveryTool,
        safetyClass: outcome.safetyClass,
        attempts: 0,
        successes: 0,
        failures: 0,
        confidence: 0,
        promoted: false,
        firstSeen: now,
        lastSeen: now,
      };
      this.policies.set(key, record);
    }

    record.attempts++;
    if (outcome.succeeded) record.successes++;
    else record.failures++;
    record.lastSeen = now;
    record.confidence = round(record.successes / record.attempts);
    record.promoted = record.attempts >= this.minAttempts && record.confidence >= this.minConfidence;
    this.enforceCap();
    this.save();
    return { ...record };
  }

  getPolicies(filter: { failureFingerprint?: string; domain?: string; triggerTool?: string } = {}): RecoveryPolicyRecord[] {
    const domain = sanitizeDomain(filter.domain);
    return Array.from(this.policies.values())
      .filter((policy) => policy.promoted)
      .filter((policy) => !filter.failureFingerprint || policy.failureFingerprint === filter.failureFingerprint)
      .filter((policy) => !domain || policy.domain === domain || policy.domain === undefined)
      .filter((policy) => !filter.triggerTool || policy.triggerTool === filter.triggerTool)
      .sort((a, b) => b.confidence - a.confidence || b.successes - a.successes)
      .map((policy) => ({ ...policy }));
  }

  clear(): void {
    this.policies.clear();
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PolicyStoreFile;
      if (!Array.isArray(parsed.policies)) return;
      for (const policy of parsed.policies.slice(-this.maxPolicies)) {
        this.policies.set(policy.id, policy);
      }
    } catch {
      // No persisted policies yet.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: PolicyStoreFile = {
        version: 1,
        updatedAt: Date.now(),
        policies: Array.from(this.policies.values()),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error(`[RecoveryPolicyLearner] save skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private enforceCap(): void {
    if (this.policies.size <= this.maxPolicies) return;
    const sorted = Array.from(this.policies.values()).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const policy of sorted.slice(0, this.policies.size - this.maxPolicies)) {
      this.policies.delete(policy.id);
    }
  }
}

export function policyRankBoost(
  policies: RecoveryPolicyRecord[] | undefined,
  recoveryTool: string,
  safetyClass: RecoveryPolicyOutcome['safetyClass'],
): number {
  if (!policies || policies.length === 0) return 0;
  const policy = policies.find((item) => item.recoveryTool === recoveryTool && item.safetyClass === safetyClass);
  if (!policy) return 0;
  return Math.min(0.25, policy.confidence * 0.2 + Math.min(policy.successes, 5) * 0.01);
}

function policyKey(outcome: RecoveryPolicyOutcome): string {
  return [
    outcome.failureFingerprint,
    sanitizeDomain(outcome.domain) ?? '*',
    outcome.triggerTool,
    outcome.recoveryTool,
    outcome.safetyClass,
  ].join('|');
}

function sanitizeDomain(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  try {
    return new URL(domain.includes('://') ? domain : `https://${domain}`).hostname.toLowerCase();
  } catch {
    return domain.toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 120) || undefined;
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
