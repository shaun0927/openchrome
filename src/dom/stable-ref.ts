/**
 * Deterministic a11y-ref — content-addressed stable ref for DOM nodes.
 * Wired into dom-serializer's `[node_refs]` block as `stable=@e<hash>`.
 * See docs/recipes/stable-a11y-refs.md.
 *
 * Origin: shared idiom from playwright-mcp (aria-ref) and Vercel
 * agent-browser (@e*). Clean-room; no upstream code copied.
 */

import { createHash } from 'crypto';

export interface StableRefInput {
  /** Lowercase tag name, e.g. 'button', 'input', 'a'. */
  tag: string;
  /** ARIA role — computed or explicit. May be undefined. */
  role?: string;
  /** Accessible name (aria-label, alt, visible text). May be undefined. */
  name?: string;
  /** Tag chain from root to parent, e.g. ['html', 'body', 'main', 'form']. */
  ancestorTags?: readonly string[];
  /** Sibling index under parent — disambiguates identical siblings. */
  siblingIndex?: number;
  /** Site-provided stable id (data-testid, name, non-generated id). Dominates. */
  stableAttr?: string;
}

const DEFAULT_HASH_HEX_LEN = 6;
const RESERVED_ROLES = new Set(['generic', 'none', 'presentation', '']);

/** Trim, lowercase, collapse whitespace incl. nbsp/zero-width. */
function normalise(part: string | undefined): string {
  if (part === undefined || part === null) return '';
  return String(part)
    .replace(/[ ​‌‍﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Build the canonical signature string that gets hashed. */
export function canonicalSignature(input: StableRefInput): string {
  const stable = normalise(input.stableAttr);
  if (stable.length > 0) {
    return [
      'stable', stable, normalise(input.tag), normalise(input.role),
      String(input.siblingIndex ?? -1),
    ].join('|');
  }
  const role = normalise(input.role);
  const roleField = RESERVED_ROLES.has(role) ? '' : role;
  return [
    'coord', normalise(input.tag), roleField, normalise(input.name),
    (input.ancestorTags ?? []).map(normalise).join('>'),
    String(input.siblingIndex ?? -1),
  ].join('|');
}

/** Deterministic 6-hex-char (default) ref for a DOM node. */
export function computeStableRef(input: StableRefInput, hexLen: number = DEFAULT_HASH_HEX_LEN): string {
  if (hexLen <= 0 || hexLen > 64) {
    throw new RangeError(`computeStableRef: hexLen must be in [1, 64], got ${hexLen}`);
  }
  return createHash('sha256').update(canonicalSignature(input)).digest('hex').slice(0, hexLen);
}

/** Composite storage-state lookup key: origin+pathname#ref (drops query/hash). */
export function refKey(input: { url: string; ref: string }): string {
  let url = input.url;
  try {
    const u = new URL(input.url);
    url = `${u.protocol}//${u.host}${u.pathname}`;
  } catch { /* leave raw */ }
  return `${url}#${input.ref}`;
}

export interface MintedRef {
  display: string;
  hash: string;
  collision: boolean;
}

/** Mint refs for a batch; disambiguates collisions with 'b','c',... suffixes. */
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
      out.push({ display: `@e${hash}${suffixFor(prior)}`, hash, collision: true });
    }
  }
  return out;
}

/** n=1→'b', n=25→'z', n=26→'bb', ... (base-25 with 'b' offset). */
function suffixFor(n: number): string {
  let value = n - 1;
  let out = '';
  do {
    const rem = value % 25;
    out = String.fromCharCode(98 + rem) + out;
    value = Math.floor(value / 25) - 1;
  } while (value >= 0);
  return out;
}
