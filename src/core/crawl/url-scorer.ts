export interface UrlScoreOptions {
  query?: string;
  keywords?: string[];
  preferPaths?: string[];
  excludePaths?: string[];
  sameDepthBias?: number;
  startUrl?: string;
}

export interface UrlScoreResult {
  score: number;
  reasons: string[];
}

const LOW_SIGNAL_SEGMENTS = new Set([
  'tag',
  'tags',
  'category',
  'categories',
  'author',
  'authors',
  'feed',
  'rss',
  'login',
  'signin',
  'signup',
  'register',
]);

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

function queryTerms(query?: string): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  for (const raw of query.split(/[^\p{L}\p{N}_-]+/u)) {
    const term = normalizeTerm(raw);
    if (term.length >= 2) seen.add(term);
  }
  return Array.from(seen);
}

function safeDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function normalizePathPrefix(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed.toLowerCase() : `/${trimmed.toLowerCase()}`;
}

function pathDistance(startPath: string, candidatePath: string): number {
  const startSegments = startPath.split('/').filter(Boolean);
  const candidateSegments = candidatePath.split('/').filter(Boolean);
  let shared = 0;
  while (
    shared < startSegments.length &&
    shared < candidateSegments.length &&
    startSegments[shared] === candidateSegments[shared]
  ) {
    shared++;
  }
  return Math.max(startSegments.length, candidateSegments.length) - shared;
}

export function buildUrlScoreOptions(input: {
  query?: unknown;
  url_score?: unknown;
  startUrl?: string;
}): UrlScoreOptions {
  const raw = input.url_score && typeof input.url_score === 'object'
    ? input.url_score as Record<string, unknown>
    : {};
  const toStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  };
  return {
    query: typeof input.query === 'string' ? input.query : undefined,
    keywords: toStringArray(raw.keywords),
    preferPaths: toStringArray(raw.prefer_paths),
    excludePaths: toStringArray(raw.exclude_paths),
    sameDepthBias: typeof raw.same_depth_bias === 'number' && Number.isFinite(raw.same_depth_bias)
      ? raw.same_depth_bias
      : undefined,
    startUrl: input.startUrl,
  };
}

export function scoreUrl(candidateUrl: string, depth: number, options: UrlScoreOptions = {}): UrlScoreResult {
  const reasons: string[] = [];
  let score = 0;
  let parsed: URL;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return { score: -100, reasons: ['invalid-url'] };
  }

  const explicitKeywords = (options.keywords || []).map(normalizeTerm).filter(Boolean);
  const terms = Array.from(new Set([...queryTerms(options.query), ...explicitKeywords]));
  const decodedPathname = safeDecodePathname(parsed.pathname);
  const haystack = `${decodedPathname} ${parsed.searchParams.toString()}`.toLowerCase();

  for (const term of terms) {
    if (!term) continue;
    if (haystack.includes(term)) {
      score += 1.0;
      reasons.push(`keyword:${term}`);
    }
  }

  for (const prefix of options.preferPaths || []) {
    const normalized = normalizePathPrefix(prefix);
    if (normalized && parsed.pathname.toLowerCase().startsWith(normalized)) {
      score += 1.5;
      reasons.push(`path:${normalized}`);
    }
  }

  for (const prefix of options.excludePaths || []) {
    const normalized = normalizePathPrefix(prefix);
    if (normalized && parsed.pathname.toLowerCase().startsWith(normalized)) {
      score -= 2.0;
      reasons.push(`exclude:${normalized}`);
    }
  }

  if (options.startUrl) {
    try {
      const start = new URL(options.startUrl);
      if (start.origin === parsed.origin) {
        const distance = pathDistance(start.pathname.toLowerCase(), parsed.pathname.toLowerCase());
        const proximity = Math.max(0, 3 - distance) * 0.1;
        if (proximity > 0) {
          score += proximity;
          reasons.push(`proximity:${proximity.toFixed(1)}`);
        }
      }
    } catch {
      // ignore malformed start URL
    }
  }

  if (options.sameDepthBias && Number.isFinite(options.sameDepthBias)) {
    score += options.sameDepthBias;
    reasons.push(`bias:${options.sameDepthBias}`);
  }

  if (depth > 0) {
    const penalty = 0.2 * depth;
    score -= penalty;
    reasons.push(`depth:-${penalty.toFixed(1)}`);
  }

  const querySet = new Set(terms);
  for (const segment of parsed.pathname.toLowerCase().split('/').filter(Boolean)) {
    if (LOW_SIGNAL_SEGMENTS.has(segment) && !querySet.has(segment)) {
      score -= 1.0;
      reasons.push(`low-signal:${segment}`);
    }
  }

  return { score: Number(score.toFixed(3)), reasons };
}
