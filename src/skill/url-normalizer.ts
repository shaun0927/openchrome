/**
 * URL normalization for state-hash inputs and skill-graph keys.
 *
 * Two pages with the same logical state should produce the same normalized
 * URL. We strip tracking params (utm_*, fbclid, …) and stable-sort the
 * remaining query keys; host is lowercased; hash fragment is dropped
 * because it never affects server-rendered state.
 *
 * The denylist is conservative — only well-known tracking params. Site-
 * specific params that look like tracking but actually carry state (Amazon
 * `pd_rd_*` is debatable but commonly noise) get a regex match. Add new
 * patterns here as we learn from real fixtures (#702 v2 capture procedure).
 */

export const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^ref$/i,
  /^tag$/i,
  /^pd_rd_/i,
  /^_encoding$/i,
  /^psc$/i,
  /^_branch_match_id$/i,
  /^mc_eid$/i,
  /^mc_cid$/i,
  /^_ke$/i,
  /^trk$/i,
  /^source$/i,
];

export interface NormalizeUrlResult {
  /** The normalized URL string. */
  url: string;
  /** Tracking params that were stripped (sorted by name, useful for evidence). */
  droppedParams: string[];
}

/**
 * Stable sentinel returned for inputs that do not parse as a URL. Chosen
 * because:
 *   • `about:invalid` is a real RFC-defined "always-invalid" address, so
 *     downstream code that treats the value as a URL won't be surprised by
 *     a host or query string.
 *   • The fragment marks it as the recorder's sentinel so operators can
 *     filter it out of skill-graph snapshots.
 * Callers must not depend on the exact string except for equality checks.
 */
export const INVALID_URL_SENTINEL = 'about:invalid#openchrome-normalize';

/**
 * Normalize a URL string for hashing/equality:
 * - lowercase the host (paths are case-sensitive on most servers; we leave them alone)
 * - drop hash fragment
 * - drop tracking params matching `TRACKING_PARAM_PATTERNS`
 * - stable-sort remaining query keys
 *
 * Total function: when the input does not parse as a URL (empty string,
 * relative path, junk text), returns `{ url: INVALID_URL_SENTINEL,
 * droppedParams: [] }` instead of throwing. This keeps `computeStateHash`
 * deterministic even when instrumentation emits incomplete URLs, e.g.
 * after a failed navigation.
 */
export function normalizeUrl(input: string): NormalizeUrlResult {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { url: INVALID_URL_SENTINEL, droppedParams: [] };
  }
  // Lowercase host only (preserve path case)
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const dropped: string[] = [];
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAM_PATTERNS.some((re) => re.test(k))) {
      dropped.push(k);
    } else {
      kept.push([k, v]);
    }
  }

  // Stable-sort by key, then value, so the same logical params produce the
  // same string regardless of authoring order.
  kept.sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1;
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  // Rebuild search string deterministically.
  const search = new URLSearchParams();
  for (const [k, v] of kept) search.append(k, v);
  u.search = search.toString();

  return { url: u.toString(), droppedParams: dropped.sort() };
}
