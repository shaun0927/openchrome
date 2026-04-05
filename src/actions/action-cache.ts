/**
 * Action Cache - Domain memory integration for caching successful action sequences.
 *
 * After a successful `act` execution, saves the instruction→sequence mapping.
 * On repeat visits to the same domain, tries the cached sequence first.
 */

import { getDomainMemory, extractDomainFromUrl } from '../memory/domain-memory';
import { ParsedAction } from './action-parser';

const CACHE_KEY_PREFIX = 'act-sequence:';
const MIN_CONFIDENCE = 0.6;

export interface CachedSequence {
  instruction: string;
  actions: ParsedAction[];
  cachedAt: number;
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

/**
 * Normalize instruction for cache key: lowercase, collapse whitespace, trim.
 */
function normalizeForCache(instruction: string): string {
  return instruction.toLowerCase().replace(/\s+/g, ' ').trim();
}
