/**
 * ReflectionStore — structured task-failure reflection artifacts.
 *
 * This is a deterministic persistence surface. It does not call an LLM and it
 * never executes the stored nextPlan. Host agents may create/read/list bounded
 * failure reflections as evidence-backed recovery guidance.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSafe, readFileSafe } from '../utils/atomic-file';

export type ReflectionTrigger =
  | 'stuck'
  | 'plan_failed'
  | 'contract_failed'
  | 'workflow_partial'
  | 'timeout';

export interface ReflectionScope {
  domain?: string;
  urlPattern?: string;
  taskFingerprint: string;
  contractId?: string;
}

export interface ReflectionEvidence {
  journalEntryIds?: string[];
  hintRules?: string[];
  failedAssertions?: string[];
  lastTools: string[];
}

export interface ReflectionArtifact {
  version: 1;
  id: string;
  createdAt: number;
  scope: ReflectionScope;
  trigger: ReflectionTrigger;
  evidence: ReflectionEvidence;
  diagnosis: string;
  nextPlan: string[];
  avoid: string[];
  confidence: number;
  expiresAt?: number;
}

export interface ReflectionCreateInput {
  scope: ReflectionScope;
  trigger: ReflectionTrigger;
  evidence: ReflectionEvidence;
  diagnosis?: string;
  nextPlan?: string[];
  avoid?: string[];
  confidence?: number;
  expiresAt?: number;
}

const DEFAULT_ROOT = path.join(os.homedir(), '.openchrome', 'reflections');
const TRIGGERS = new Set<ReflectionTrigger>([
  'stuck',
  'plan_failed',
  'contract_failed',
  'workflow_partial',
  'timeout',
]);
const SENSITIVE = /(password|token|secret|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi;

export class ReflectionStore {
  constructor(private readonly rootDir = DEFAULT_ROOT) {}

  async create(input: ReflectionCreateInput): Promise<ReflectionArtifact> {
    this.validateInput(input);
    const now = Date.now();
    const artifact: ReflectionArtifact = {
      version: 1,
      id: makeId(now),
      createdAt: now,
      scope: sanitizeScope(input.scope),
      trigger: input.trigger,
      evidence: sanitizeEvidence(input.evidence),
      diagnosis: boundedText(input.diagnosis ?? defaultDiagnosis(input), 1000),
      nextPlan: boundedList(input.nextPlan ?? defaultPlan(input), 7, 1000),
      avoid: boundedList(input.avoid ?? defaultAvoid(input), 7, 1000),
      confidence: clamp(input.confidence ?? 0.5),
      ...(typeof input.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {}),
    };

    await writeFileAtomicSafe(this.pathFor(artifact.id), artifact);
    return artifact;
  }

  async get(id: string): Promise<ReflectionArtifact | null> {
    if (!isSafeId(id)) return null;
    const result = await readFileSafe<ReflectionArtifact>(this.pathFor(id));
    if (!result.success || !result.data || !isArtifact(result.data)) return null;
    return result.data;
  }

  list(filter?: { domain?: string; taskFingerprint?: string; contractId?: string; limit?: number; includeExpired?: boolean }): ReflectionArtifact[] {
    const limit = Math.max(0, Math.min(filter?.limit ?? 3, 100));
    const now = Date.now();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.rootDir).filter((file) => file.endsWith('.json'));
    } catch {
      return [];
    }

    const artifacts: ReflectionArtifact[] = [];
    for (const file of files) {
      const fullPath = path.join(this.rootDir, file);
      try {
        const artifact = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as ReflectionArtifact;
        if (!isArtifact(artifact)) continue;
        if (filter?.domain && artifact.scope.domain !== filter.domain) continue;
        if (filter?.taskFingerprint && artifact.scope.taskFingerprint !== filter.taskFingerprint) continue;
        if (filter?.contractId && artifact.scope.contractId !== filter.contractId) continue;
        if (!filter?.includeExpired && artifact.expiresAt !== undefined && artifact.expiresAt <= now) continue;
        artifacts.push(artifact);
      } catch {
        // Ignore corrupt reflection files. The store is best-effort and must
        // not crash the MCP server during context recovery.
      }
    }

    return artifacts
      .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async validate(id: string, success: boolean): Promise<ReflectionArtifact | null> {
    const artifact = await this.get(id);
    if (!artifact) return null;
    artifact.confidence = clamp(artifact.confidence + (success ? 0.1 : -0.2));
    if (artifact.confidence < 0.2) {
      try {
        fs.unlinkSync(this.pathFor(id));
      } catch {
        // Best-effort pruning.
      }
      return null;
    }
    await writeFileAtomicSafe(this.pathFor(id), artifact);
    return artifact;
  }

  private validateInput(input: ReflectionCreateInput): void {
    if (!input || typeof input !== 'object') throw new Error('input must be an object');
    if (!TRIGGERS.has(input.trigger)) throw new Error(`invalid trigger: ${String(input.trigger)}`);
    if (!input.scope || typeof input.scope.taskFingerprint !== 'string' || input.scope.taskFingerprint.trim() === '') {
      throw new Error('scope.taskFingerprint is required');
    }
    if (!input.evidence || !Array.isArray(input.evidence.lastTools)) {
      throw new Error('evidence.lastTools is required');
    }
    if (input.nextPlan !== undefined && !Array.isArray(input.nextPlan)) throw new Error('nextPlan must be an array');
    if (input.avoid !== undefined && !Array.isArray(input.avoid)) throw new Error('avoid must be an array');
  }

  private pathFor(id: string): string {
    return path.join(this.rootDir, `${id}.json`);
  }
}

function sanitizeScope(scope: ReflectionScope): ReflectionScope {
  return {
    ...(scope.domain ? { domain: boundedText(scope.domain, 253) } : {}),
    ...(scope.urlPattern ? { urlPattern: boundedText(scope.urlPattern, 500) } : {}),
    taskFingerprint: boundedText(scope.taskFingerprint, 200),
    ...(scope.contractId ? { contractId: boundedText(scope.contractId, 200) } : {}),
  };
}

function sanitizeEvidence(evidence: ReflectionEvidence): ReflectionEvidence {
  return {
    journalEntryIds: boundedList(evidence.journalEntryIds ?? [], 20, 200),
    hintRules: boundedList(evidence.hintRules ?? [], 20, 200),
    failedAssertions: boundedList(evidence.failedAssertions ?? [], 20, 1000),
    lastTools: boundedList(evidence.lastTools, 20, 100),
  };
}

function boundedList(items: string[], limit: number, maxChars: number): string[] {
  return items.slice(0, limit).map((item) => boundedText(String(item), maxChars)).filter(Boolean);
}

function boundedText(text: string, maxChars: number): string {
  return text.replace(SENSITIVE, '$1=[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').slice(0, maxChars).trim();
}

function defaultDiagnosis(input: ReflectionCreateInput): string {
  return `Task attempt reached ${input.trigger}; inspect supplied evidence before retrying.`;
}

function defaultPlan(input: ReflectionCreateInput): string[] {
  if (input.trigger === 'contract_failed') return ['Inspect failed assertions', 'Collect fresh page evidence', 'Retry only after expected state is visible'];
  if (input.trigger === 'timeout') return ['Check partial page state', 'Use a narrower wait condition', 'Retry with a bounded timeout'];
  return ['Stop the repeated path', 'Review last tools and hints', 'Try a different recovery strategy'];
}

function defaultAvoid(input: ReflectionCreateInput): string[] {
  if (input.evidence.lastTools.length > 0) return [`Do not repeat ${input.evidence.lastTools[input.evidence.lastTools.length - 1]} without new evidence`];
  return ['Do not repeat the same failed action without new evidence'];
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function makeId(now: number): string {
  return `refl-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSafeId(id: string): boolean {
  return /^refl-[0-9]+-[a-z0-9]+$/.test(id);
}

function isArtifact(value: unknown): value is ReflectionArtifact {
  const artifact = value as ReflectionArtifact;
  return artifact?.version === 1 && typeof artifact.id === 'string' && typeof artifact.createdAt === 'number' &&
    !!artifact.scope && typeof artifact.scope.taskFingerprint === 'string' && TRIGGERS.has(artifact.trigger) &&
    !!artifact.evidence && Array.isArray(artifact.evidence.lastTools) && Array.isArray(artifact.nextPlan) &&
    Array.isArray(artifact.avoid) && typeof artifact.confidence === 'number';
}
