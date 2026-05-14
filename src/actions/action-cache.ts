/**
 * Action Cache - Domain memory integration for caching successful action sequences.
 *
 * After a successful `act` execution, saves the instruction→sequence mapping.
 * On repeat visits to the same domain, tries the cached sequence first.
 */

import { createHash } from 'crypto';

import { getDomainMemory, extractDomainFromUrl } from '../memory/domain-memory';
import { ParsedAction } from './action-parser';

const CACHE_KEY_PREFIX = 'act-sequence:';
const WORKFLOW_CACHE_KEY_PREFIX = 'act-workflow:';
const CACHE_V2_KEY_PREFIX = 'act-sequence-v2:';
const MIN_CONFIDENCE = 0.6;
const DEFAULT_SIGNATURE_THRESHOLD = 0.75;


export type ActionCacheStatus = 'HIT' | 'MISS' | 'STALE' | 'BYPASS';

export interface ActionCacheKeyV2Parts {
  version: 2;
  domain: string;
  urlPattern: string;
  normalizedInstruction: string;
  actionKinds: string[];
  viewport: { width: number; height: number };
  locale?: string;
  userAgentClass?: 'chrome' | 'chromium' | 'unknown';
  pageFingerprint: string;
  optionFingerprint: string;
}

export interface CachedSequenceV2 extends CachedSequence {
  version: 2;
  keyVersion: 2;
  keyHash: string;
  keyParts: ActionCacheKeyV2Parts;
  metadata: {
    status?: ActionCacheStatus;
    createdAt: number;
    lastUsedAt?: number;
  };
}

export interface ActionCacheV2LookupDecision {
  status: ActionCacheStatus;
  keyVersion: 2 | 1;
  reason: string;
  keyHash?: string;
  entry?: CachedSequenceV2;
  legacy?: CachedSequence;
  actions?: ParsedAction[];
}

export interface CachedSequence {
  instruction: string;
  actions: ParsedAction[];
  cachedAt: number;
}

export interface WorkflowPageSignature {
  titleHash?: string;
  actionLabelsHash: string;
  actionRolesHash: string;
  formShapeHash?: string;
}

export interface WorkflowSignatureProjection {
  title?: string;
  actionLabels: string[];
  actionRoles: string[];
  formShape?: string[];
}

export interface WorkflowCacheStep {
  action: ParsedAction['action'];
  target?: string;
  valueKind?: 'literal' | 'variable' | 'empty';
  value?: string;
  selectorHint?: string;
}

export interface WorkflowCacheEntry {
  version: 1;
  id: string;
  domain: string;
  urlPattern: string;
  instructionNormalized: string;
  createdAt: number;
  lastUsedAt?: number;
  confidence: number;
  pageSignature: WorkflowPageSignature;
  steps: WorkflowCacheStep[];
  safety: {
    containsTextEntry: boolean;
    containsNavigation: boolean;
    destructiveRisk: 'none' | 'possible' | 'blocked';
    replayAllowed: boolean;
  };
  stats: {
    successes: number;
    failures: number;
    lastFailureReason?: string;
  };
}

export interface WorkflowCacheLookupOptions {
  allowRiskyReplay?: boolean;
  minConfidence?: number;
  signatureThreshold?: number;
}

export interface WorkflowCacheDecision {
  decision: 'miss' | 'accepted' | 'rejected';
  reason: string;
  similarity?: number;
  cacheAction?: 'decrement_confidence';
  safety?: WorkflowCacheEntry['safety'];
  entry?: WorkflowCacheEntry;
  actions?: ParsedAction[];
}


export function buildActionCacheKeyV2Parts(input: {
  url: string;
  instruction: string;
  actionKinds: string[];
  viewport: { width: number; height: number };
  pageFingerprint: string;
  optionFingerprint?: string;
  locale?: string;
  userAgent?: string;
}): ActionCacheKeyV2Parts | null {
  const domain = extractDomainFromUrl(input.url);
  const urlPattern = buildUrlPattern(input.url);
  if (!domain || !urlPattern) return null;

  return {
    version: 2,
    domain,
    urlPattern,
    normalizedInstruction: normalizeForCache(input.instruction),
    actionKinds: stableList(input.actionKinds),
    viewport: {
      width: Math.max(0, Math.round(input.viewport.width || 0)),
      height: Math.max(0, Math.round(input.viewport.height || 0)),
    },
    ...(input.locale ? { locale: normalizeForCache(input.locale).slice(0, 24) } : {}),
    userAgentClass: classifyUserAgent(input.userAgent),
    pageFingerprint: boundedHash(input.pageFingerprint),
    optionFingerprint: boundedHash(input.optionFingerprint || 'default'),
  };
}

export function getActionCacheKeyV2Hash(parts: ActionCacheKeyV2Parts): string {
  return boundedHash(JSON.stringify(parts));
}

export function getCachedSequenceV2(
  url: string,
  instruction: string,
  keyParts: ActionCacheKeyV2Parts,
  options: { allowLegacyFallback?: boolean } = {}
): ActionCacheV2LookupDecision {
  const domain = extractDomainFromUrl(url);
  if (!domain) return { status: 'BYPASS', keyVersion: 2, reason: 'invalid_url' };

  const keyHash = getActionCacheKeyV2Hash(keyParts);
  const memory = getDomainMemory();
  const entries = memory.query(domain, CACHE_V2_KEY_PREFIX + normalizeForCache(instruction));
  let sawCandidate = false;

  for (const knowledge of entries) {
    const entry = parseCachedSequenceV2(knowledge.value);
    if (!entry) continue;
    if (knowledge.confidence < MIN_CONFIDENCE) continue;
    sawCandidate = true;
    if (entry.keyHash === keyHash) {
      return { status: 'HIT', keyVersion: 2, reason: 'key_match', keyHash, entry, actions: entry.actions };
    }
  }

  if (sawCandidate) {
    return { status: 'STALE', keyVersion: 2, reason: 'page_or_option_fingerprint_mismatch', keyHash };
  }

  if (options.allowLegacyFallback) {
    const legacy = getCachedSequence(url, instruction);
    if (legacy) {
      return { status: 'HIT', keyVersion: 1, reason: 'legacy_v1_fallback', keyHash, legacy, actions: legacy.actions };
    }
  }

  return { status: 'MISS', keyVersion: 2, reason: 'no_candidate', keyHash };
}

export function cacheSequenceV2(url: string, instruction: string, actions: ParsedAction[], keyParts: ActionCacheKeyV2Parts): CachedSequenceV2 | null {
  const domain = extractDomainFromUrl(url);
  if (!domain) return null;

  const keyHash = getActionCacheKeyV2Hash(keyParts);
  const value: CachedSequenceV2 = {
    version: 2,
    keyVersion: 2,
    keyHash,
    keyParts,
    instruction,
    actions,
    cachedAt: Date.now(),
    metadata: { createdAt: Date.now() },
  };

  const memory = getDomainMemory();
  const key = CACHE_V2_KEY_PREFIX + normalizeForCache(instruction);
  memory.record(domain, key, JSON.stringify(value));
  memory.validate(memory.query(domain, key)[0]?.id ?? '', true);
  return value;
}

export function validateCachedSequenceV2(url: string, instruction: string, keyHash: string, success: boolean): void {
  const domain = extractDomainFromUrl(url);
  if (!domain) return;

  const key = CACHE_V2_KEY_PREFIX + normalizeForCache(instruction);
  const memory = getDomainMemory();
  const entries = memory.query(domain, key);
  const matched = entries.find(entry => parseCachedSequenceV2(entry.value)?.keyHash === keyHash);
  if (matched) memory.validate(matched.id, success);
}

/**
 * Look up a cached action sequence for the given instruction and domain.
 * Returns null if no cache hit or confidence is too low.
 */
export function getCachedSequence(url: string, instruction: string): CachedSequence | null {
  const domain = extractDomainFromUrl(url);
  if (!domain) return null;

  const key = CACHE_KEY_PREFIX + normalizeForCache(instruction);
  const memory = getDomainMemory();
  const entries = memory.query(domain, key);

  if (entries.length === 0) return null;

  const best = entries[0]; // Already sorted by confidence desc
  if (best.confidence < MIN_CONFIDENCE) return null;

  try {
    const cached: CachedSequence = JSON.parse(best.value);
    return cached;
  } catch {
    return null;
  }
}

/**
 * Cache a successful action sequence for the given domain.
 */
export function cacheSequence(url: string, instruction: string, actions: ParsedAction[]): void {
  const domain = extractDomainFromUrl(url);
  if (!domain) return;

  const key = CACHE_KEY_PREFIX + normalizeForCache(instruction);
  const value: CachedSequence = {
    instruction,
    actions,
    cachedAt: Date.now(),
  };

  const memory = getDomainMemory();
  memory.record(domain, key, JSON.stringify(value));
}

/**
 * Report success/failure for a cached sequence to adjust confidence.
 */
export function validateCachedSequence(url: string, instruction: string, success: boolean): void {
  const domain = extractDomainFromUrl(url);
  if (!domain) return;

  const key = CACHE_KEY_PREFIX + normalizeForCache(instruction);
  const memory = getDomainMemory();
  const entries = memory.query(domain, key);

  if (entries.length > 0) {
    memory.validate(entries[0].id, success);
  }
}

export function buildWorkflowPageSignature(projection: WorkflowSignatureProjection): WorkflowPageSignature {
  return {
    titleHash: projection.title ? stableHash(normalizeForCache(projection.title)) : undefined,
    actionLabelsHash: stableHash(stableList(projection.actionLabels).join('|')),
    actionRolesHash: stableHash(stableList(projection.actionRoles).join('|')),
    formShapeHash: projection.formShape && projection.formShape.length > 0
      ? stableHash(stableList(projection.formShape).join('|'))
      : undefined,
  };
}

export function cacheWorkflowSequence(
  url: string,
  instruction: string,
  actions: ParsedAction[],
  pageSignature: WorkflowPageSignature
): WorkflowCacheEntry | null {
  const domain = extractDomainFromUrl(url);
  const urlPattern = buildUrlPattern(url);
  if (!domain || !urlPattern) return null;

  const instructionNormalized = normalizeWorkflowInstruction(instruction, actions);
  const cacheKeySuffix = normalizeWorkflowKey(instruction);
  const safety = buildWorkflowSafety(instruction, actions);
  const entry: WorkflowCacheEntry = {
    version: 1,
    id: `wf-${Date.now()}-${stableHash(`${domain}:${cacheKeySuffix}`).slice(0, 8)}`,
    domain,
    urlPattern,
    instructionNormalized,
    createdAt: Date.now(),
    confidence: MIN_CONFIDENCE,
    pageSignature,
    steps: sanitizeWorkflowSteps(actions),
    safety,
    stats: { successes: 1, failures: 0 },
  };

  const key = WORKFLOW_CACHE_KEY_PREFIX + cacheKeySuffix;
  const memory = getDomainMemory();
  memory.record(domain, key, JSON.stringify(entry));
  memory.validate(memory.query(domain, key)[0]?.id ?? '', true);
  return entry;
}

export function getWorkflowCachedSequence(
  url: string,
  instruction: string,
  pageSignature: WorkflowPageSignature,
  options: WorkflowCacheLookupOptions = {}
): WorkflowCacheDecision {
  const domain = extractDomainFromUrl(url);
  const currentPattern = buildUrlPattern(url);
  if (!domain || !currentPattern) return { decision: 'miss', reason: 'invalid_url' };

  const key = WORKFLOW_CACHE_KEY_PREFIX + normalizeWorkflowKey(instruction);
  const memory = getDomainMemory();
  const entries = memory.query(domain, key);
  if (entries.length === 0) return { decision: 'miss', reason: 'no_candidate' };

  const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
  const signatureThreshold = options.signatureThreshold ?? DEFAULT_SIGNATURE_THRESHOLD;
  let lastRejected: WorkflowCacheDecision | null = null;

  for (const knowledge of entries) {
    const entry = parseWorkflowEntry(knowledge.value);
    if (!entry) {
      lastRejected = { decision: 'rejected', reason: 'invalid_entry' };
      continue;
    }

    const confidence = Math.min(knowledge.confidence, entry.confidence);
    if (confidence < minConfidence) {
      lastRejected = { decision: 'rejected', reason: 'confidence_below_threshold', entry };
      continue;
    }
    if (entry.urlPattern !== currentPattern) {
      lastRejected = { decision: 'rejected', reason: 'url_pattern_mismatch', entry };
      continue;
    }

    const similarity = calculateSignatureSimilarity(entry.pageSignature, pageSignature);
    if (similarity < signatureThreshold) {
      lastRejected = { decision: 'rejected', reason: 'page_signature_mismatch', similarity, entry };
      continue;
    }

    if (!entry.safety.replayAllowed && !options.allowRiskyReplay) {
      lastRejected = { decision: 'rejected', reason: 'safety_policy_blocked', similarity, safety: entry.safety, entry };
      continue;
    }

    // Variable-kind steps store no literal value (secret redaction). Replay
    // would always fail at executeType/executeSelect because workflowStepToAction
    // drops the value field. Reject here so callers see a clear reason instead
    // of a downstream EXCEPTION that decays confidence.
    if (entry.steps.some(step => step.valueKind === 'variable')) {
      lastRejected = { decision: 'rejected', reason: 'requires_variable_substitution', similarity, safety: entry.safety, entry };
      continue;
    }

    return {
      decision: 'accepted',
      reason: 'accepted',
      similarity,
      safety: entry.safety,
      entry,
      actions: entry.steps.map(step => workflowStepToAction(step)),
    };
  }

  return lastRejected ?? { decision: 'miss', reason: 'no_candidate' };
}

export function validateWorkflowCachedSequence(
  url: string,
  instruction: string,
  success: boolean,
  lastFailureReason?: string
): WorkflowCacheDecision {
  const domain = extractDomainFromUrl(url);
  if (!domain) return { decision: 'miss', reason: 'invalid_url' };

  const key = WORKFLOW_CACHE_KEY_PREFIX + normalizeWorkflowKey(instruction);
  const memory = getDomainMemory();
  const entries = memory.query(domain, key);
  if (entries.length === 0) return { decision: 'miss', reason: 'no_candidate' };

  const knowledge = entries[0];
  const entry = parseWorkflowEntry(knowledge.value);
  if (!entry) return { decision: 'rejected', reason: 'invalid_entry' };

  entry.lastUsedAt = Date.now();
  if (success) {
    entry.stats.successes += 1;
    entry.confidence = Math.min(1, entry.confidence + 0.1);
  } else {
    entry.stats.failures += 1;
    entry.stats.lastFailureReason = lastFailureReason || 'replay_failed';
    entry.confidence = Math.max(0, entry.confidence - 0.2);
  }

  memory.record(domain, key, JSON.stringify(entry));
  memory.validate(memory.query(domain, key)[0]?.id ?? knowledge.id, success);

  return {
    decision: success ? 'accepted' : 'rejected',
    reason: success ? 'validated_success' : (entry.stats.lastFailureReason || 'replay_failed'),
    cacheAction: success ? undefined : 'decrement_confidence',
    entry,
  };
}


function parseCachedSequenceV2(value: string): CachedSequenceV2 | null {
  try {
    const parsed = JSON.parse(value) as CachedSequenceV2;
    if (parsed?.version !== 2 || parsed?.keyVersion !== 2 || !parsed.keyHash || !Array.isArray(parsed.actions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function boundedHash(input: string): string {
  return createHash('sha256').update(String(input).slice(0, 20_000)).digest('hex').slice(0, 24);
}

function classifyUserAgent(userAgent?: string): 'chrome' | 'chromium' | 'unknown' {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('chromium')) return 'chromium';
  if (ua.includes('chrome')) return 'chrome';
  return 'unknown';
}

/**
 * Normalize instruction for cache key: lowercase, collapse whitespace, trim.
 */
function normalizeForCache(instruction: string): string {
  return instruction.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Cache-key derivation: deterministic, action-agnostic so record/lookup paths
// always produce the same key. Per-token isSecretLike masks high-entropy
// tokens; we intentionally do not redact short literal values pulled from
// action.value here, because lookup callers do not have the action list
// available and any asymmetry causes guaranteed cache misses.
function normalizeWorkflowKey(instruction: string): string {
  return normalizeForCache(instruction)
    .split(' ')
    .map(token => isSecretLike(token) ? '{{variable}}' : token)
    .join(' ');
}

// Stored-entry normalization: includes action.value-aware redaction so short
// secret literals (e.g. "hunter2") that survive the per-token entropy check
// do not leak into the persisted entry. Used only for the recorded display
// form, not for cache key derivation.
function normalizeWorkflowInstruction(instruction: string, actions: ParsedAction[] = []): string {
  let normalized = normalizeForCache(instruction);
  for (const action of actions) {
    if (action.value && (isSecretLike(action.value) || isSecretLike(action.target))) {
      normalized = normalized.replaceAll(normalizeForCache(action.value), '{{variable}}');
    }
  }
  return normalized
    .split(' ')
    .map(token => isSecretLike(token) ? '{{variable}}' : token)
    .join(' ');
}

function stableList(values: string[]): string[] {
  return values
    .map(value => normalizeForCache(value))
    .filter(Boolean)
    .sort()
    .slice(0, 200);
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildUrlPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function parseWorkflowEntry(value: string): WorkflowCacheEntry | null {
  try {
    const parsed = JSON.parse(value) as WorkflowCacheEntry;
    if (parsed?.version !== 1 || !Array.isArray(parsed.steps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function calculateSignatureSimilarity(a: WorkflowPageSignature, b: WorkflowPageSignature): number {
  const pairs = ([
    [a.titleHash, b.titleHash],
    [a.actionLabelsHash, b.actionLabelsHash],
    [a.actionRolesHash, b.actionRolesHash],
    [a.formShapeHash, b.formShapeHash],
  ] as Array<[string | undefined, string | undefined]>)
    .filter(([left, right]) => Boolean(left || right));

  if (pairs.length === 0) return 0;
  const matches = pairs.filter(([left, right]) => left === right).length;
  return Math.round((matches / pairs.length) * 100) / 100;
}

function sanitizeWorkflowSteps(actions: ParsedAction[]): WorkflowCacheStep[] {
  return actions.map(action => {
    const secret = isSecretLike(action.value) || isSecretLike(action.target);
    const value = action.value || '';
    return {
      action: action.action,
      target: action.target,
      valueKind: !value ? 'empty' : secret ? 'variable' : 'literal',
      ...(value && !secret ? { value } : {}),
    };
  });
}

function workflowStepToAction(step: WorkflowCacheStep): ParsedAction {
  return {
    action: step.action,
    target: step.target,
    ...(step.valueKind === 'literal' && step.value ? { value: step.value } : {}),
  };
}

function buildWorkflowSafety(instruction: string, actions: ParsedAction[]): WorkflowCacheEntry['safety'] {
  const containsTextEntry = actions.some(action => action.action === 'type' || action.action === 'select');
  const containsNavigation = actions.some(action => action.action === 'navigate');
  const text = [instruction, ...actions.flatMap(action => [action.target, action.value])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const destructiveRisk = /\b(delete|remove|purchase|buy|checkout|submit payment|transfer|send|publish|confirm|irreversible)\b/.test(text)
    ? 'possible'
    : 'none';
  const hasSecret = actions.some(action => isSecretLike(action.target) || isSecretLike(action.value));

  return {
    containsTextEntry,
    containsNavigation,
    destructiveRisk,
    replayAllowed: destructiveRisk === 'none' && !hasSecret,
  };
}

function isSecretLike(value?: string): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  if (/password|passcode|mfa|otp|2fa|token|secret|api[_ -]?key|credential/.test(text)) return true;
  return /^[A-Za-z0-9_-]{24,}$/.test(value);
}
