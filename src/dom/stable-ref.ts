/**
 * Deterministic a11y-ref — content-addressed stable references for DOM nodes.
 *
 * Why this exists
 * ---------------
 * openchrome's DOM serializer prefixes each node line with the CDP
 * `backendNodeId` (`[123]<button ... />`). That id is stable **within a
 * single page load**, but the moment the page reloads, navigates back and
 * forth, or the DOM is re-hydrated by client-side JS the id churns. Any
 * cached plan ("click ref 123 after typing into 47") is instantly stale.
 *
 * Two upstream projects landed the same fix independently:
 *
 *  - Vercel's agent-browser mints refs like `@e1`, `@e2` where the leading
 *    integer is a per-page counter but the resolution is DOM-content hash
 *    keyed. Two identical buttons at the same DOM slot get the same `@e*`
 *    across reloads.
 *  - playwright-mcp's accessibility-tree snapshots surface an `aria-ref`
 *    computed from the element's ARIA role, accessible name, and tree
 *    coordinate.
 *
 * This module ports the shared principle: `computeStableRef({ tag, role,
 * name, ancestorTags, siblingIndex })` produces a short (6-hex) hash that
 * survives reload as long as the node's identity signature stays the same.
 *
 * Design
 * ------
 * - The hash input is a canonical, whitespace-normalised, lowercased
 *   composition of the node's identity signature. The intention is that
 *   two DOM snapshots of "the same element" (from an agent's point of
 *   view) hash equal.
 * - Uses SHA-256 via node:crypto and truncates to 6 hex chars (~24 bits,
 *   ≈1 collision per 4096 nodes at 50% probability — the DOM serializer
 *   caps at DEFAULT_MAX_SERIALIZER_NODES ≪ that). Collisions are
 *   surfaced by `mintPageRefs()` which resolves them to `@e1`, `@e1b`
 *   without regressing determinism (b, c, d… are added by insertion
 *   order, still deterministic given the same input).
 * - Zero dependency on the puppeteer session — pure function. Callers
 *   assemble the signature from whatever DOM source they have (CDP a11y
 *   tree, `dom-serializer`'s `DOMNode`, or the storage-state manager's
 *   cached snapshot). Testable in isolation.
 *
 * Storage-state reuse contract
 * ----------------------------
 * The same stable ref can be persisted alongside `storage_state` and
 * looked up on the next navigation. `refKey({ url, ref })` is the
 * documented composite lookup key so downstream cache layers agree.
 *
 * Origin credit
 * -------------
 * Idiom shared by playwright-mcp (Apache-2.0, `aria-ref`) and Vercel's
 * agent-browser (Apache-2.0, `@e*`). Clean-room implementation; no
 * upstream code copied.
 */

import { createHash } from 'crypto';

export interface StableRefInput {
  /** Lowercase tag name, e.g. 'button', 'input', 'a'. */
  tag: string;
  /** ARIA role — computed or explicit. May be undefined. */
  role?: string;
  /** Accessible name (aria-label, alt, visible text). May be undefined. */
  name?: string;
  /**
   * Tag chain from root to parent, e.g. ['html', 'body', 'main', 'form'].
   * Included so two `<button>` at different DOM positions hash different.
   */
  ancestorTags?: readonly string[];
  /**
   * Sibling index of the node under its parent. Included so two identical
   * siblings (e.g. two "Delete" buttons in a list) hash different.
   */
  siblingIndex?: number;
  /**
   * Optional stable id/attribute the site itself provides — data-testid,
   * name, or the `id` attribute if it looks non-generated. When present,
   * this dominates the hash and the tree coordinates become secondary.
   */
  stableAttr?: string;
}

const DEFAULT_HASH_HEX_LEN = 6;
const RESERVED_ROLES = new Set(['generic', 'none', 'presentation', '']);

/**
 * Normalise an identity component for hashing. Trims, lowercases,
 * collapses whitespace, and drops surrounding punctuation that a browser
 * might add or remove between reloads (nbsp, zero-width space).
 */
function normalise(part: string | undefined): string {
  if (part === undefined || part === null) return '';
  return String(part)
    .replace(/[ ​‌‍﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build the canonical signature string that gets hashed. Exposed so
 * tests and debugging tools can see exactly what would be hashed.
 */
export function canonicalSignature(input: StableRefInput): string {
  const stable = normalise(input.stableAttr);
  if (stable.length > 0) {
    // Site-provided stable attributes dominate — the rest of the tree
    // coordinate is folded in only to disambiguate two nodes that share
    // the same attribute (rare, but possible with e.g. duplicated
    // data-testid).
    return [
      'stable',
      stable,
      normalise(input.tag),
      normalise(input.role),
      String(input.siblingIndex ?? -1),
    ].join('|');
  }
  const role = normalise(input.role);
  const roleField = RESERVED_ROLES.has(role) ? '' : role;
  return [
    'coord',
    normalise(input.tag),
    roleField,
    normalise(input.name),
    (input.ancestorTags ?? []).map(normalise).join('>'),
    String(input.siblingIndex ?? -1),
  ].join('|');
}

/**
 * Compute a deterministic 6-hex-char ref for a DOM node. Repeated calls
 * with the same input produce the same output; two "same-looking" nodes
 * from different snapshots collapse to the same ref.
 */
export function computeStableRef(input: StableRefInput, hexLen: number = DEFAULT_HASH_HEX_LEN): string {
  if (hexLen <= 0 || hexLen > 64) {
    throw new RangeError(`computeStableRef: hexLen must be in [1, 64], got ${hexLen}`);
  }
  const sig = canonicalSignature(input);
  const digest = createHash('sha256').update(sig).digest('hex');
  return digest.slice(0, hexLen);
}

/**
 * Compose the storage-state lookup key. URL is normalised to origin +
 * pathname (query/hash intentionally excluded — most SPAs surface the
 * same DOM under many query strings).
 */
export function refKey(input: { url: string; ref: string }): string {
  const url = normaliseUrlForKey(input.url);
  return `${url}#${input.ref}`;
}

function normaliseUrlForKey(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw;
  }
}

export interface MintedRef {
  /** The final display ref, e.g. `@e1a2b3c` or `@e1a2b3cb` on collision. */
  display: string;
  /** The raw hash slice before collision suffix, useful for storage lookup. */
  hash: string;
  /** True when this ref collided with an earlier input and got a suffix. */
  collision: boolean;
}

/**
 * Mint refs for a batch of inputs in one pass. When two inputs hash to
 * the same value, the later ones get a deterministic suffix (`b`, `c`,
 * `d`…) so display refs remain unique per page. Insertion order is the
 * disambiguator; identical input in the same order always mints the
 * same output — determinism is preserved.
 */
export function mintPageRefs(inputs: readonly StableRefInput[], hexLen: number = DEFAULT_HASH_HEX_LEN): MintedRef[] {
  const seen = new Map<string, number>();
  const out: MintedRef[] = [];
  for (const input of inputs) {
    const hash = computeStableRef(input, hexLen);
    const prior = seen.get(hash) ?? 0;
    seen.set(hash, prior + 1);
    if (prior === 0) {
      out.push({ display: `@e${hash}`, hash, collision: false });
    } else {
      // 'b' for second occurrence, 'c' for third… After 25 we wrap into
      // two-letter suffixes so pathological pages (26+ identical siblings
      // with no stableAttr) still get unique displays. Deterministic.
      const suffix = suffixFor(prior);
      out.push({ display: `@e${hash}${suffix}`, hash, collision: true });
    }
  }
  return out;
}

function suffixFor(n: number): string {
  // n=1 → 'b', n=2 → 'c', …, n=25 → 'z', n=26 → 'bb', n=27 → 'bc'…
  // Encode n as base-25 with digits 0..24, offset by 1 so n=1 maps to 'b'.
  let value = n - 1;
  let out = '';
  do {
    const rem = value % 25;
    out = String.fromCharCode(98 + rem) + out; // 98 = 'b'
    value = Math.floor(value / 25) - 1;
  } while (value >= 0);
  return out;
}
