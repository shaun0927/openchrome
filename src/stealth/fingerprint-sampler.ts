/**
 * Real-distribution fingerprint sampler.
 *
 * The current `src/stealth/fingerprint-defense.ts` picks values from a small
 * static table, which is trivially profileable — every session ends up with
 * the same few UA / screen / timezone tuples. Anti-bot vendors already
 * fingerprint that exact table.
 *
 * The fix, popularised by browserforge/fingerprint-suite, is to sample from
 * a joint distribution that reflects the real user population: locale is
 * correlated with timezone, timezone with screen ratio, device pixel ratio
 * with UA platform, and so on. Independent uniform sampling of each field
 * produces impossible combinations (e.g. `ko-KR` + `America/New_York` +
 * `en-US` accept-language) that themselves become a signal.
 *
 * This module encodes a small joint distribution over the fields openchrome
 * currently exposes, plus a deterministic sampler keyed by a caller-supplied
 * `seed` so the same session always yields the same fingerprint. That
 * property matters because a legitimate user's fingerprint is stable across
 * navigations within a session.
 *
 * Clean-room implementation. Idea attribution (see census entry A20):
 * browserforge/fingerprint-suite. Also incorporates the Bezier idea from
 * pydoll (A8) via {@link bezierPointerPath}, kept in this module because
 * fingerprint and motion are two sides of the same "look human" coin.
 */

export interface FingerprintSample {
  userAgent: string;
  platform: 'Win32' | 'MacIntel' | 'Linux x86_64';
  language: string;
  languages: readonly string[];
  timezone: string;
  screen: { width: number; height: number; devicePixelRatio: number };
  hardwareConcurrency: number;
  deviceMemoryGB: number;
}

interface JointRow {
  weight: number;
  sample: FingerprintSample;
}

/**
 * The joint table is intentionally small. Each row is a plausible
 * co-occurrence — locale, timezone, screen and UA all agree.
 *
 * Weights are ordinal proxies for population share; they do not need to sum
 * to 1 because the sampler normalises.
 */
const JOINT_TABLE: readonly JointRow[] = [
  {
    weight: 22,
    sample: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'en-US',
      languages: ['en-US', 'en'],
      timezone: 'America/New_York',
      screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
      hardwareConcurrency: 8,
      deviceMemoryGB: 16,
    },
  },
  {
    weight: 14,
    sample: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'en-GB',
      languages: ['en-GB', 'en'],
      timezone: 'Europe/London',
      screen: { width: 1536, height: 864, devicePixelRatio: 1.25 },
      hardwareConcurrency: 8,
      deviceMemoryGB: 8,
    },
  },
  {
    weight: 12,
    sample: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      language: 'en-US',
      languages: ['en-US', 'en'],
      timezone: 'America/Los_Angeles',
      screen: { width: 1728, height: 1117, devicePixelRatio: 2 },
      hardwareConcurrency: 10,
      deviceMemoryGB: 16,
    },
  },
  {
    weight: 8,
    sample: {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      language: 'en-US',
      languages: ['en-US', 'en'],
      timezone: 'UTC',
      screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
      hardwareConcurrency: 12,
      deviceMemoryGB: 32,
    },
  },
  {
    weight: 9,
    sample: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'de-DE',
      languages: ['de-DE', 'de', 'en'],
      timezone: 'Europe/Berlin',
      screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
      hardwareConcurrency: 8,
      deviceMemoryGB: 16,
    },
  },
  {
    weight: 7,
    sample: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      language: 'fr-FR',
      languages: ['fr-FR', 'fr', 'en'],
      timezone: 'Europe/Paris',
      screen: { width: 1440, height: 900, devicePixelRatio: 2 },
      hardwareConcurrency: 8,
      deviceMemoryGB: 16,
    },
  },
  {
    weight: 6,
    sample: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'ja-JP',
      languages: ['ja-JP', 'ja', 'en'],
      timezone: 'Asia/Tokyo',
      screen: { width: 1920, height: 1080, devicePixelRatio: 1 },
      hardwareConcurrency: 8,
      deviceMemoryGB: 16,
    },
  },
  {
    weight: 5,
    sample: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      language: 'ko-KR',
      languages: ['ko-KR', 'ko', 'en'],
      timezone: 'Asia/Seoul',
      screen: { width: 1512, height: 982, devicePixelRatio: 2 },
      hardwareConcurrency: 10,
      deviceMemoryGB: 16,
    },
  },
  {
    weight: 4,
    sample: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      platform: 'Win32',
      language: 'pt-BR',
      languages: ['pt-BR', 'pt', 'en'],
      timezone: 'America/Sao_Paulo',
      screen: { width: 1366, height: 768, devicePixelRatio: 1 },
      hardwareConcurrency: 4,
      deviceMemoryGB: 8,
    },
  },
];

/**
 * Sample a fingerprint from the joint distribution.
 *
 * Deterministic if a `seed` is provided — same seed always yields the same
 * sample. Callers should pick a seed once per session (e.g. from the
 * session id) and reuse it, so within-session navigation looks stable.
 */
export function sampleFingerprint(seed?: string): FingerprintSample {
  const totalWeight = JOINT_TABLE.reduce((sum, row) => sum + row.weight, 0);
  const pick = seed !== undefined ? hash32(seed) / 2 ** 32 : Math.random();
  let cursor = pick * totalWeight;
  for (const row of JOINT_TABLE) {
    cursor -= row.weight;
    if (cursor <= 0) return row.sample;
  }
  return JOINT_TABLE[JOINT_TABLE.length - 1]!.sample;
}

/**
 * Small stable hash — Fowler-Noll-Vo 32. Written from the spec, not copied.
 * Enough entropy for weighted sampling; not cryptographic.
 */
export function hash32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Squash to unsigned 32-bit.
  return hash >>> 0;
}

// -----------------------------------------------------------------------
// Bezier pointer path — extends src/stealth/human-behavior.ts idiom to
// arbitrary control points so a caller can synthesise a curved cursor path
// between two page coordinates.
// -----------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface BezierPathOptions {
  /** Number of intermediate points to emit (excludes endpoints). */
  steps?: number;
  /** Jitter magnitude for the control points. Higher = curvier. */
  curveMagnitude?: number;
  /** Deterministic seed. */
  seed?: string;
}

/**
 * Produce a cubic Bezier path from `from` to `to` with two randomised
 * control points. The path is naturally arced and non-monotone, which is
 * what human motion looks like — a straight-line + easing curve, which is
 * what most bots produce, is trivially detectable.
 */
export function bezierPointerPath(
  from: Point,
  to: Point,
  options: BezierPathOptions = {},
): Point[] {
  const steps = Math.max(2, options.steps ?? 24);
  const magnitude = options.curveMagnitude ?? 0.35;
  const rng = seededRng(options.seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Control points offset perpendicular to the travel vector.
  const perpX = -dy;
  const perpY = dx;
  const c1: Point = {
    x: from.x + dx / 3 + perpX * magnitude * (rng() - 0.5),
    y: from.y + dy / 3 + perpY * magnitude * (rng() - 0.5),
  };
  const c2: Point = {
    x: from.x + (2 * dx) / 3 + perpX * magnitude * (rng() - 0.5),
    y: from.y + (2 * dy) / 3 + perpY * magnitude * (rng() - 0.5),
  };
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push(cubicBezier(from, c1, c2, to, t));
  }
  return out;
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

function seededRng(seed?: string): () => number {
  if (seed === undefined) return Math.random;
  let state = hash32(seed) || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 2 ** 32;
  };
}
