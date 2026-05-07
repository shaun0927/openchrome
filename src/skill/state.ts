/**
 * Deterministic state hashing for the skill-graph nodes.
 *
 * Two visits to "the same logical page" must produce the same hash. Two
 * meaningfully different states (logged-out vs logged-in, empty cart vs
 * has-item) must differ. Concretely we hash:
 *
 *   1. Normalized URL (host lowercased, tracking params stripped, query
 *      keys sorted) — see `url-normalizer.ts`.
 *   2. Histogram of interactive-element tag-paths — captures structural
 *      identity without being sensitive to dynamic ad/news content.
 *   3. Sorted set of visible top-level headings (h1-h3 text after
 *      whitespace collapse).
 *   4. Bitmap flags for known landmarks: login form, payment fields,
 *      cart count badge, modal overlay, captcha challenge.
 *
 * The output is `{ hash, evidence }`; callers persist `hash` in the graph
 * DB and stash `evidence` in the node's `evidence_blob` so an operator
 * inspecting the graph can see why two states differed.
 */

import * as crypto from 'node:crypto';

import { normalizeUrl } from './url-normalizer';
import { isInteractiveNode, type InteractiveProbe } from './interactive-filter';

/** A snapshot the hasher consumes — produced from a real page or a fixture. */
export interface PageSnapshot {
  url: string;
  /** Top-level interactive elements with their tag-path from `<body>`. */
  interactives: Array<InteractiveProbe & { tagPath: string }>;
  /** Visible h1/h2/h3 text (innerText, whitespace-collapsed). */
  headings: string[];
  /** Landmark probes — `true` when the landmark is detected on the page. */
  landmarks: LandmarkFlags;
}

export interface LandmarkFlags {
  loginForm?: boolean;
  paymentFields?: boolean;
  cartBadge?: boolean;
  modalOverlay?: boolean;
  captchaChallenge?: boolean;
}

const LANDMARK_BIT_ORDER: (keyof LandmarkFlags)[] = [
  'loginForm',
  'paymentFields',
  'cartBadge',
  'modalOverlay',
  'captchaChallenge',
];

export interface StateHashEvidence {
  url_normalized: string;
  url_dropped_params: string[];
  interactive_node_count: number;
  /** Sorted (tag-path → count) pairs. Stable across visits. */
  interactive_histogram: Array<[string, number]>;
  heading_set: string[];
  landmark_flags: number;
  /** Bump when the algorithm changes; old hashes can be compared by version. */
  hash_components_version: 1;
}

export interface StateHashResult {
  /** 64-bit hex (16 chars) — derived from SHA-256 truncated to first 64 bits. */
  hash: string;
  evidence: StateHashEvidence;
}

/**
 * Build the canonical evidence object for a snapshot. Pure; no I/O.
 */
function buildEvidence(snapshot: PageSnapshot): StateHashEvidence {
  const { url: url_normalized, droppedParams } = normalizeUrl(snapshot.url);

  // Histogram of interactive tag-paths (only nodes the predicate accepts).
  const counts = new Map<string, number>();
  for (const node of snapshot.interactives) {
    if (!isInteractiveNode(node)) continue;
    counts.set(node.tagPath, (counts.get(node.tagPath) ?? 0) + 1);
  }
  const histogram = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // Stable heading set: trim, collapse whitespace, drop empty, sort, unique.
  const headingSet = [
    ...new Set(
      snapshot.headings
        .map((h) => h.replace(/\s+/g, ' ').trim())
        .filter((h) => h.length > 0),
    ),
  ].sort();

  // Bitmap of detected landmarks.
  let bits = 0;
  LANDMARK_BIT_ORDER.forEach((flag, i) => {
    if (snapshot.landmarks[flag]) bits |= 1 << i;
  });

  return {
    url_normalized,
    url_dropped_params: droppedParams,
    interactive_node_count: snapshot.interactives.filter(isInteractiveNode).length,
    interactive_histogram: histogram,
    heading_set: headingSet,
    landmark_flags: bits,
    hash_components_version: 1,
  };
}

/**
 * Subset of the evidence that contributes to the hash. Diagnostic-only
 * fields like `url_dropped_params` are excluded so two snapshots that
 * differ only in tracking-param presence still hash identically.
 */
function hashInput(evidence: StateHashEvidence): Record<string, unknown> {
  // Pick fields explicitly — easier to audit than picking out the omitted ones.
  return {
    url_normalized: evidence.url_normalized,
    interactive_histogram: evidence.interactive_histogram,
    heading_set: evidence.heading_set,
    landmark_flags: evidence.landmark_flags,
    hash_components_version: evidence.hash_components_version,
  };
}

/**
 * Compute a deterministic 64-bit hex hash from the snapshot. The hash is
 * the first 16 hex chars of SHA-256(canonicalJSON(hashInput(evidence))).
 * Truncation is acceptable because the value space (potentially infinite
 * real-world pages) is far smaller than 2^64; collision risk on a
 * per-domain graph with thousands of nodes is negligible.
 *
 * `url_dropped_params` is intentionally NOT part of the hash — it is
 * diagnostic only.
 */
export function computeStateHash(snapshot: PageSnapshot): StateHashResult {
  const evidence = buildEvidence(snapshot);
  const canonical = canonicalJson(hashInput(evidence));
  const sha = crypto.createHash('sha256').update(canonical).digest('hex');
  return { hash: sha.slice(0, 16), evidence };
}

/**
 * Stable JSON: object keys sorted recursively. Arrays preserve order
 * because the inputs are already sorted by `buildEvidence`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
