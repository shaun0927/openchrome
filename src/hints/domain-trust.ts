/**
 * Domain trust — reputation scoring for extraction / result sources.
 *
 * Why this exists
 * ---------------
 * openchrome's HintEngine turns tool results into next-action hints,
 * but it treats every source URL the same. In practice a `wikipedia.org`
 * result is not the same evidence weight as a `some-random-blog.tk`
 * result. HKUDS/AI-Researcher's Resource Filter idiom scores each
 * source by category (curated ref, government, org, primary source,
 * SNS, aggregator, unknown) and lets downstream steps weight
 * accordingly.
 *
 * openchrome uses this in two places:
 *
 *  1. `hint-engine.ts` result-guidance — when a tool returns URLs, the
 *     hint layer can annotate "this looks like a primary source"
 *     versus "this looks like aggregator soup".
 *  2. `pattern-learner.ts` — the score becomes a feature in the
 *     failure-episode learner so a pattern that reliably crashes on
 *     low-trust sources gets a domain-scoped hint rather than a
 *     global one.
 *
 * Design
 * ------
 * - Pure module. No dependency on any tool result shape — the caller
 *   passes a URL and gets back `{ score, category, rationale }`.
 * - Score is 0..1. The lookup is deterministic: classifier rules run
 *   in a fixed order, first match wins.
 * - Extension point `registerDomainTrustRule()` for callers who want
 *   to layer site-specific trust on top of the defaults (e.g. an
 *   internal wiki that should score 0.9). Registrations do not
 *   mutate the defaults — they are consulted first.
 *
 * Origin credit
 * -------------
 * Idiom from HKUDS/AI-Researcher's Resource Filter (unlicensed).
 * Clean-room implementation; no upstream code copied.
 */

export type TrustCategory =
  | 'primary-reference'
  | 'academic'
  | 'government'
  | 'organisation'
  | 'news-established'
  | 'aggregator'
  | 'user-generated'
  | 'unknown';

export interface TrustResult {
  score: number;
  category: TrustCategory;
  rationale: string;
}

export interface DomainTrustRule {
  /** Runs against the lowercased hostname. */
  match: (hostname: string) => boolean;
  category: TrustCategory;
  score: number;
  rationale: string;
}

const DEFAULT_RULES: DomainTrustRule[] = [
  {
    match: (h) => h === 'wikipedia.org' || h.endsWith('.wikipedia.org'),
    category: 'primary-reference',
    score: 0.85,
    rationale: 'wikipedia — curated reference',
  },
  {
    match: (h) => h.endsWith('.arxiv.org') || h === 'arxiv.org' || h === 'pubmed.ncbi.nlm.nih.gov',
    category: 'academic',
    score: 0.9,
    rationale: 'academic archive',
  },
  {
    match: (h) => h.endsWith('.edu') || h.endsWith('.ac.kr') || h.endsWith('.ac.uk') || h.endsWith('.ac.jp'),
    category: 'academic',
    score: 0.85,
    rationale: 'academic institution TLD',
  },
  {
    match: (h) => h.endsWith('.gov') || h.endsWith('.go.kr') || h.endsWith('.gov.uk') || h.endsWith('.gc.ca'),
    category: 'government',
    score: 0.9,
    rationale: 'government TLD',
  },
  {
    match: (h) => h.endsWith('.mil'),
    category: 'government',
    score: 0.9,
    rationale: 'military TLD',
  },
  {
    match: (h) => h.endsWith('.or.kr') || h.endsWith('.org'),
    category: 'organisation',
    score: 0.6,
    rationale: 'organisation TLD',
  },
  {
    match: (h) => /(?:^|\.)(?:nytimes|bbc|reuters|ft|economist|apnews|npr|wsj|washingtonpost|guardian)\.(?:com|co\.uk|org)$/.test(h),
    category: 'news-established',
    score: 0.7,
    rationale: 'established news',
  },
  {
    match: (h) => /(?:^|\.)(?:medium|substack|hackernoon|dev\.to)\.com$/.test(h) || h.endsWith('.blogspot.com') || h.endsWith('.wordpress.com') || h.endsWith('.tistory.com'),
    category: 'aggregator',
    score: 0.35,
    rationale: 'blog aggregator',
  },
  {
    match: (h) => /(?:^|\.)(?:reddit|twitter|x|facebook|instagram|tiktok|youtube|linkedin|threads)\.com$/.test(h),
    category: 'user-generated',
    score: 0.25,
    rationale: 'user-generated content',
  },
];

const _customRules: DomainTrustRule[] = [];

/** Add a caller-defined rule, consulted before the defaults. */
export function registerDomainTrustRule(rule: DomainTrustRule): void {
  if (typeof rule.match !== 'function' || typeof rule.score !== 'number') {
    throw new TypeError('registerDomainTrustRule: match and score are required');
  }
  if (rule.score < 0 || rule.score > 1) {
    throw new RangeError('registerDomainTrustRule: score must be in [0, 1]');
  }
  _customRules.push(rule);
}

/** Test-only reset. */
export function resetDomainTrustRulesForTests(): void {
  _customRules.length = 0;
}

/**
 * Score a URL for source trust. Malformed URLs return an unknown
 * category with score 0.
 */
export function scoreDomain(url: string): TrustResult {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { score: 0, category: 'unknown', rationale: 'malformed url' };
  }
  if (host.startsWith('www.')) host = host.slice(4);
  for (const rule of _customRules) {
    if (rule.match(host)) {
      return { score: rule.score, category: rule.category, rationale: rule.rationale };
    }
  }
  for (const rule of DEFAULT_RULES) {
    if (rule.match(host)) {
      return { score: rule.score, category: rule.category, rationale: rule.rationale };
    }
  }
  return { score: 0.4, category: 'unknown', rationale: 'no matching rule' };
}

/** Rank a list of URLs by trust score, ties broken by input order. */
export function rankByTrust(urls: readonly string[]): { url: string; trust: TrustResult }[] {
  return urls
    .map((url, i) => ({ url, trust: scoreDomain(url), _i: i }))
    .sort((a, b) => (b.trust.score - a.trust.score) || (a._i - b._i))
    .map(({ url, trust }) => ({ url, trust }));
}
