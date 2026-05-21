/**
 * DOM-skeleton signature for the v2 state-graph node hash.
 *
 * A skeleton is a coarse equivalence class over "what is on this
 * page": structural tag tree, ARIA landmarks, and counts of high-
 * signal interactive elements. The shape deliberately discards:
 *
 *   - Text content (changes on every refresh).
 *   - Element IDs / class names (often template-generated).
 *   - Specific URLs inside links (the URL of the page itself is
 *     handled separately by the v1 canonicalisation that v2 still
 *     subsumes).
 *
 * What it preserves:
 *
 *   - Top-N levels of the tag tree (default 3 levels, max 64 nodes).
 *   - Presence of ARIA landmark roles (`main`, `navigation`,
 *     `banner`, `complementary`, `contentinfo`, `search`, `region`,
 *     `form`).
 *   - Integer counts (bucketed to log-2 brackets so small fluctuations
 *     do not change the signature) of forms, buttons, inputs, links,
 *     and headings.
 *
 * The skeleton is canonicalised via stable key ordering so two
 * functionally identical trees produce identical bytes after
 * `canonicalizeSkeleton(s)`.
 */

export interface DomSkeletonNode {
  /** Lower-cased tag name. */
  readonly tag: string;
  /** Optional ARIA role if present on the element. */
  readonly role?: string;
  /** Top-N children retained, in document order. */
  readonly children?: ReadonlyArray<DomSkeletonNode>;
}

export interface DomSkeletonCounts {
  readonly forms: number;
  readonly buttons: number;
  readonly inputs: number;
  readonly links: number;
  readonly headings: number;
}

export interface DomSkeleton {
  /** Structural tag tree (root is typically `<body>`). */
  readonly tree: DomSkeletonNode;
  /** ARIA landmark roles present anywhere on the page, sorted. */
  readonly landmarks: ReadonlyArray<string>;
  /** Bucketed counts of high-signal interactive elements. */
  readonly counts: DomSkeletonCounts;
}

/** Maximum retained structural levels, counting the root as level 1. */
export const DOM_SKELETON_MAX_DEPTH = 3;

/** Maximum retained structural nodes in document order. */
export const DOM_SKELETON_MAX_NODES = 64;

/**
 * Bucket integer counts to log-2 brackets:
 *   0      → 0
 *   1      → 1
 *   2..3   → 2
 *   4..7   → 4
 *   8..15  → 8
 *   16..31 → 16
 *   ...
 *
 * This keeps the skeleton stable across small DOM fluctuations
 * (paginated product cards, lazy-loaded thumbnails, etc.) while
 * still distinguishing a 3-button form from a 300-button form.
 */
export function bucketCount(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n === 1) return 1;
  // 2^floor(log2(n))
  return 1 << Math.floor(Math.log2(n));
}

/**
 * Lower-cases a tag, strips anything that isn't an alphanumeric or
 * `-` (so a hostile DOM cannot inject `\0` separator bytes into the
 * canonical string). Returns `''` for inputs we cannot safely
 * encode; callers drop these nodes from the skeleton.
 */
function safeTag(tag: string | undefined | null): string {
  if (typeof tag !== 'string') return '';
  const lower = tag.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(lower)) return '';
  return lower;
}

function safeRole(role: string | undefined | null): string | undefined {
  if (typeof role !== 'string') return undefined;
  const lower = role.toLowerCase().trim();
  if (lower.length === 0 || lower.length > 32) return undefined;
  if (!/^[a-z][a-z0-9-]*$/.test(lower)) return undefined;
  return lower;
}

/**
 * Normalise a raw skeleton (e.g., from the CDP probe or a user fake)
 * into a canonical shape so two functionally identical inputs always
 * produce identical `canonicalizeSkeleton()` strings.
 *
 * - Tag names lower-cased and validated against `[a-z][a-z0-9-]*`.
 * - Roles validated identically; absent or invalid roles dropped.
 * - Empty `children` arrays dropped to keep the canonical form tight.
 * - Landmarks de-duplicated, validated, lower-cased, sorted ASCII.
 * - Counts coerced through `bucketCount`.
 *
 * Returns `null` when the root tag fails validation — the caller
 * treats this as "skeleton unavailable" and falls back to v1.
 */
export function normaliseSkeleton(raw: DomSkeleton | null | undefined): DomSkeleton | null {
  if (!raw || typeof raw !== 'object') return null;
  const budget = { remaining: DOM_SKELETON_MAX_NODES };
  const tree = normaliseNode(raw.tree, 1, budget);
  if (tree === null) return null;
  const landmarksRaw = Array.isArray(raw.landmarks) ? raw.landmarks : [];
  const landmarks: string[] = [];
  const seen = new Set<string>();
  for (const lm of landmarksRaw) {
    const role = safeRole(lm);
    if (role === undefined) continue;
    if (seen.has(role)) continue;
    seen.add(role);
    landmarks.push(role);
  }
  landmarks.sort();
  const counts = raw.counts ?? { forms: 0, buttons: 0, inputs: 0, links: 0, headings: 0 };
  return {
    tree,
    landmarks,
    counts: {
      forms: bucketCount(counts.forms ?? 0),
      buttons: bucketCount(counts.buttons ?? 0),
      inputs: bucketCount(counts.inputs ?? 0),
      links: bucketCount(counts.links ?? 0),
      headings: bucketCount(counts.headings ?? 0),
    },
  };
}

function normaliseNode(
  raw: DomSkeletonNode | undefined,
  depth: number,
  budget: { remaining: number },
): DomSkeletonNode | null {
  if (depth > DOM_SKELETON_MAX_DEPTH || budget.remaining <= 0) return null;
  if (!raw || typeof raw !== 'object') return null;
  const tag = safeTag(raw.tag);
  if (tag === '') return null;
  budget.remaining -= 1;
  const role = safeRole(raw.role);
  const childrenRaw = Array.isArray(raw.children) ? raw.children : [];
  const children: DomSkeletonNode[] = [];
  if (depth < DOM_SKELETON_MAX_DEPTH) {
    for (const child of childrenRaw) {
      if (budget.remaining <= 0) break;
      const norm = normaliseNode(child, depth + 1, budget);
      if (norm !== null) children.push(norm);
    }
  }
  const node: DomSkeletonNode = role !== undefined
    ? (children.length > 0 ? { tag, role, children } : { tag, role })
    : (children.length > 0 ? { tag, children } : { tag });
  return node;
}

/**
 * Canonicalise a normalised skeleton to a stable byte string.
 * Stable key ordering (`landmarks`, `counts`, `tree`) and stable
 * counts-key ordering guarantee byte-for-byte equality on any input
 * that survives `normaliseSkeleton` identically.
 *
 * The output is deliberately readable JSON so future debug tooling
 * (skill viewer, audit-log dashboards) can dump the canonical input
 * without an extra decoder.
 */
export function canonicalizeSkeleton(s: DomSkeleton): string {
  const counts = s.counts;
  // Lock the key order so two skeletons that only differ by JS
  // object insertion order still canonicalise the same.
  const orderedCounts = {
    buttons: counts.buttons,
    forms: counts.forms,
    headings: counts.headings,
    inputs: counts.inputs,
    links: counts.links,
  };
  return JSON.stringify({
    counts: orderedCounts,
    landmarks: s.landmarks,
    tree: canonicalizeNode(s.tree),
  });
}

function canonicalizeNode(n: DomSkeletonNode): unknown {
  const out: Record<string, unknown> = { tag: n.tag };
  if (n.role !== undefined) out.role = n.role;
  if (n.children !== undefined && n.children.length > 0) {
    out.children = n.children.map(canonicalizeNode);
  }
  return out;
}
