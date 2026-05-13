import * as fs from 'fs';
import * as path from 'path';

export interface FailureEpisodeContext {
  domain?: string;
  taskIntent?: string;
  stateFingerprint?: string;
  actionSummary?: string;
  evidenceSummary?: string;
}

export interface FailureEpisode {
  id: string;
  domain: string;
  task_intent: string;
  state_fingerprint: string;
  failed_tool: string;
  failed_action_summary: string;
  error_fingerprint: string;
  recovery_summary: string;
  recovery_tools: string[];
  success_evidence_summary: string;
  confidence: number;
  attempts: number;
  successes: number;
  created_at: number;
  updated_at: number;
}

interface FailureEpisodeFile {
  version: 1;
  episodes: FailureEpisode[];
  updatedAt: number;
}

export interface FailureEpisodeStoreOptions {
  filePath?: string;
  now?: () => number;
  maxEpisodes?: number;
  staleAfterMs?: number;
}

const DEFAULT_MAX_EPISODES = 100;
const DEFAULT_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const UNKNOWN = 'unknown';

export class FailureEpisodeStore {
  private readonly now: () => number;
  private readonly maxEpisodes: number;
  private readonly staleAfterMs: number;
  private filePath: string | null;
  private episodes: FailureEpisode[] = [];

  constructor(options: FailureEpisodeStoreOptions = {}) {
    this.filePath = options.filePath ?? null;
    this.now = options.now ?? Date.now;
    this.maxEpisodes = options.maxEpisodes ?? DEFAULT_MAX_EPISODES;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (this.filePath) this.load();
  }

  enablePersistence(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
    this.filePath = path.join(dirPath, 'failure-episodes.json');
    this.load();
  }

  recordVerifiedRecovery(input: {
    failedTool: string;
    errorFingerprint: string;
    recoveryTool: string;
    failure?: FailureEpisodeContext;
    recovery?: FailureEpisodeContext;
  }): FailureEpisode {
    const now = this.now();
    const domain = normalizeDomain(input.failure?.domain ?? input.recovery?.domain);
    const errorFingerprint = sanitizeText(input.errorFingerprint, 120) || UNKNOWN;
    const failedTool = sanitizeText(input.failedTool, 80) || UNKNOWN;
    const recoveryTool = sanitizeText(input.recoveryTool, 80) || UNKNOWN;
    const existing = this.episodes.find((episode) =>
      episode.domain === domain &&
      episode.failed_tool === failedTool &&
      episode.error_fingerprint === errorFingerprint &&
      episode.recovery_tools.includes(recoveryTool),
    );

    if (existing) {
      existing.task_intent = chooseMoreSpecific(existing.task_intent, input.failure?.taskIntent);
      existing.state_fingerprint = chooseMoreSpecific(existing.state_fingerprint, input.failure?.stateFingerprint);
      existing.failed_action_summary = chooseMoreSpecific(existing.failed_action_summary, input.failure?.actionSummary);
      existing.recovery_summary = chooseMoreSpecific(existing.recovery_summary, input.recovery?.actionSummary ?? recoveryTool);
      existing.success_evidence_summary = chooseMoreSpecific(existing.success_evidence_summary, input.recovery?.evidenceSummary);
      existing.confidence = clampConfidence(existing.confidence + 0.1);
      existing.attempts++;
      existing.successes++;
      existing.updated_at = now;
      this.pruneAndSave();
      return existing;
    }

    const episode: FailureEpisode = {
      id: `episode-${now}-${stableSlug(`${domain}-${failedTool}-${errorFingerprint}-${recoveryTool}`)}`,
      domain,
      task_intent: sanitizeText(input.failure?.taskIntent, 160) || UNKNOWN,
      state_fingerprint: sanitizeText(input.failure?.stateFingerprint, 160) || UNKNOWN,
      failed_tool: failedTool,
      failed_action_summary: sanitizeText(input.failure?.actionSummary, 160) || failedTool,
      error_fingerprint: errorFingerprint,
      recovery_summary: sanitizeText(input.recovery?.actionSummary ?? recoveryTool, 160) || recoveryTool,
      recovery_tools: [recoveryTool],
      success_evidence_summary: sanitizeText(input.recovery?.evidenceSummary, 160) || 'verified successful follow-up tool call',
      confidence: 0.6,
      attempts: 1,
      successes: 1,
      created_at: now,
      updated_at: now,
    };
    this.episodes.push(episode);
    this.pruneAndSave();
    return episode;
  }

  recordFailedReuse(episodeId: string): void {
    const episode = this.episodes.find((candidate) => candidate.id === episodeId);
    if (!episode) return;
    episode.attempts++;
    episode.confidence = clampConfidence(episode.confidence - 0.2);
    episode.updated_at = this.now();
    this.pruneAndSave();
  }

  match(input: {
    failedTool: string;
    errorFingerprint: string;
    domain?: string;
    taskIntent?: string;
    stateFingerprint?: string;
  }): FailureEpisode | null {
    const now = this.now();
    const domain = normalizeDomain(input.domain);
    const errorFingerprint = sanitizeText(input.errorFingerprint, 120) || UNKNOWN;
    const taskTokens = tokenize(input.taskIntent ?? '');
    const stateTokens = tokenize(input.stateFingerprint ?? '');

    let best: { episode: FailureEpisode; score: number } | null = null;
    for (const episode of this.episodes) {
      if (now - episode.updated_at > this.staleAfterMs) continue;
      if (episode.confidence < 0.3) continue;
      if (episode.failed_tool !== input.failedTool) continue;
      if (episode.domain !== UNKNOWN && domain !== UNKNOWN && episode.domain !== domain) continue;
      if (!compatibleFingerprint(episode.error_fingerprint, errorFingerprint)) continue;

      const score = episode.confidence +
        overlapScore(taskTokens, tokenize(episode.task_intent)) * 0.25 +
        overlapScore(stateTokens, tokenize(episode.state_fingerprint)) * 0.15;
      if (!best || score > best.score) best = { episode, score };
    }
    return best?.episode ?? null;
  }

  buildHint(episode: FailureEpisode): string {
    return 'Hint: Similar failure episode learned on ' + episode.domain +
      ` (${episode.error_fingerprint}). Suggested recovery: ${episode.recovery_summary}` +
      ` using ${episode.recovery_tools.join(', ')}; confidence=${episode.confidence.toFixed(2)}.` +
      ' Validate before acting; no recovery was auto-executed.';
  }

  list(): FailureEpisode[] {
    this.prune();
    return this.episodes.slice();
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FailureEpisodeFile;
      this.episodes = Array.isArray(parsed.episodes) ? parsed.episodes.map(normalizeEpisode).filter(Boolean) as FailureEpisode[] : [];
      this.prune();
    } catch {
      this.episodes = [];
    }
  }

  private pruneAndSave(): void {
    this.prune();
    this.save();
  }

  private prune(): void {
    const cutoff = this.now() - this.staleAfterMs;
    this.episodes = this.episodes
      .filter((episode) => episode.confidence >= 0.3 && episode.updated_at >= cutoff)
      .sort((a, b) => b.confidence - a.confidence || b.updated_at - a.updated_at)
      .slice(0, this.maxEpisodes);
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: FailureEpisodeFile = { version: 1, episodes: this.episodes, updatedAt: this.now() };
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Best-effort memory; never break hinting.
    }
  }
}

export function buildFailureEpisodeContext(input: {
  args?: Record<string, unknown>;
  resultText?: string;
}): FailureEpisodeContext {
  const args = input.args ?? {};
  return {
    domain: extractDomain(args.url) ?? extractDomain(input.resultText),
    taskIntent: stringFrom(args.task ?? args.intent ?? args.description ?? args.query ?? args.goal),
    stateFingerprint: summarizeState(input.resultText),
    actionSummary: summarizeAction(args),
    evidenceSummary: summarizeEvidence(input.resultText),
  };
}

function normalizeEpisode(raw: FailureEpisode): FailureEpisode | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: sanitizeText(raw.id, 120) || `episode-${Date.now()}`,
    domain: normalizeDomain(raw.domain),
    task_intent: sanitizeText(raw.task_intent, 160) || UNKNOWN,
    state_fingerprint: sanitizeText(raw.state_fingerprint, 160) || UNKNOWN,
    failed_tool: sanitizeText(raw.failed_tool, 80) || UNKNOWN,
    failed_action_summary: sanitizeText(raw.failed_action_summary, 160) || UNKNOWN,
    error_fingerprint: sanitizeText(raw.error_fingerprint, 120) || UNKNOWN,
    recovery_summary: sanitizeText(raw.recovery_summary, 160) || UNKNOWN,
    recovery_tools: Array.isArray(raw.recovery_tools) ? raw.recovery_tools.map((tool) => sanitizeText(tool, 80)).filter(Boolean) : [],
    success_evidence_summary: sanitizeText(raw.success_evidence_summary, 160) || UNKNOWN,
    confidence: clampConfidence(Number(raw.confidence)),
    attempts: Number.isFinite(raw.attempts) ? Math.max(0, Math.floor(raw.attempts)) : 0,
    successes: Number.isFinite(raw.successes) ? Math.max(0, Math.floor(raw.successes)) : 0,
    created_at: Number.isFinite(raw.created_at) ? raw.created_at : Date.now(),
    updated_at: Number.isFinite(raw.updated_at) ? raw.updated_at : Date.now(),
  };
}

function summarizeAction(args: Record<string, unknown>): string | undefined {
  const description = stringFrom(args.description ?? args.action ?? args.selector ?? args.text ?? args.url);
  return description ? sanitizeText(description, 160) : undefined;
}

function summarizeState(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flags = [
    /overlay|modal|dialog/i.test(text) ? 'overlay-present' : '',
    /login|auth|sign in/i.test(text) ? 'auth-visible' : '',
    /stale|detached|not found/i.test(text) ? 'stale-or-missing-element' : '',
    /timeout|timed out/i.test(text) ? 'timeout' : '',
  ].filter(Boolean);
  return flags.length > 0 ? flags.join(':') : sanitizeText(text, 120);
}

function summarizeEvidence(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (/success|done|completed|saved|visible|clicked|submitted/i.test(text)) return sanitizeText(text, 160);
  return 'successful follow-up tool call';
}

function sanitizeText(value: unknown, limit: number): string {
  const raw = stringFrom(value);
  if (!raw) return '';
  const redacted = raw
    .replace(/([\w.+-]+)@([\w.-]+\.[a-z]{2,})/gi, '[REDACTED_EMAIL]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(password|token|secret|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:[A-Za-z0-9+/]{32,}={0,2}|[a-f0-9]{32,})\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.slice(0, limit);
}

function normalizeDomain(value: unknown): string {
  const raw = stringFrom(value);
  if (!raw) return UNKNOWN;
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 120) || UNKNOWN;
  }
}

function extractDomain(value: unknown): string | undefined {
  const raw = stringFrom(value);
  if (!raw) return undefined;
  const url = raw.match(/https?:\/\/[^\s"')]+/i)?.[0] ?? raw;
  const domain = normalizeDomain(url);
  return domain === UNKNOWN ? undefined : domain;
}

function stringFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function chooseMoreSpecific(current: string, next: unknown): string {
  const sanitized = sanitizeText(next, 160);
  if (!sanitized || sanitized === UNKNOWN) return current;
  if (!current || current === UNKNOWN || sanitized.length > current.length) return sanitized;
  return current;
}

function compatibleFingerprint(left: string, right: string): boolean {
  return left.includes(right) || right.includes(left) || overlapScore(tokenize(left), tokenize(right)) >= 0.5;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches++;
  return matches / Math.max(left.size, right.size);
}

function stableSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'failure';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.6;
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
