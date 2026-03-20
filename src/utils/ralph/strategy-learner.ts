/**
 * Strategy Learner — remembers which interaction strategy worked for
 * specific element roles on specific domains.
 *
 * When a non-default strategy (S3+) succeeds, it's stored in domain memory
 * so future interactions on the same domain start with the proven strategy
 * instead of always running S1→S2→S3→... from the beginning.
 *
 * Uses the existing getDomainMemory() infrastructure — no new storage.
 */

import { getDomainMemory, extractDomainFromUrl } from '../../memory/domain-memory';

/** Strategy identifiers matching ralph-engine.ts */
export type StrategyId = 'S1_AX' | 'S2_CSS' | 'S3_CDP_COORD' | 'S4_JS_INJECT' | 'S5_KEYBOARD' | 'S6_CDP_RAW' | 'S7_HITL';

/** Key prefix for strategy entries in domain memory */
const STRATEGY_KEY_PREFIX = 'ralph:strategy';

/**
 * Record a successful strategy for a given element role on a domain.
 *
 * Only records S3+ strategies (S1 AX and S2 CSS are already defaults —
 * no value in remembering them).
 *
 * @param url - Current page URL (domain is extracted)
 * @param role - Element role (e.g., 'radio', 'button', 'checkbox')
 * @param strategyId - The strategy that succeeded
 */
export function learnStrategy(url: string, role: string, strategyId: StrategyId): void {
  // Only learn non-default strategies
  if (strategyId === 'S1_AX' || strategyId === 'S2_CSS' || strategyId === 'S7_HITL') {
    return;
  }

  const domain = extractDomainFromUrl(url);
  if (!domain) return;

  const key = `${STRATEGY_KEY_PREFIX}:${role.toLowerCase()}`;
  getDomainMemory().record(domain, key, strategyId);
}

/**
 * Look up a previously learned strategy for an element role on a domain.
 *
 * @param url - Current page URL
 * @param role - Element role to look up
 * @returns The preferred strategy ID, or null if no learning exists
 */
export function getLearnedStrategy(url: string, role: string | undefined): StrategyId | null {
  if (!role) return null;

  const domain = extractDomainFromUrl(url);
  if (!domain) return null;

  const key = `${STRATEGY_KEY_PREFIX}:${role.toLowerCase()}`;
  const entries = getDomainMemory().query(domain, key);

  if (entries.length === 0) return null;

  const best = entries[0]; // sorted by confidence desc
  if (best.confidence < 0.3) return null; // too low confidence — don't trust

  return best.value as StrategyId;
}

/**
 * Record a strategy failure — decays the confidence of the learned strategy.
 *
 * @param url - Current page URL
 * @param role - Element role
 * @param strategyId - The strategy that failed
 */
export function recordStrategyFailure(url: string, role: string, strategyId: StrategyId): void {
  const domain = extractDomainFromUrl(url);
  if (!domain) return;

  const key = `${STRATEGY_KEY_PREFIX}:${role.toLowerCase()}`;
  const entries = getDomainMemory().query(domain, key);

  const match = entries.find(e => e.value === strategyId);
  if (match) {
    getDomainMemory().validate(match.id, false); // confidence -= 0.2
  }
}
