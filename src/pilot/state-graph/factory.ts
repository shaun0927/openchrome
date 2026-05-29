/**
 * Factory for the runtime's `computeStateHash` callback.
 *
 * Two shapes are accepted (see overloads):
 *
 *   1. `createStateHasher(getUrl)` — legacy v1-only path. Callers
 *      that only have a URL handy (e.g. a label-only risk probe that
 *      carries `pageUrl` as a string) keep using this signature; the
 *      hasher returns a v1 hash and never crosses into v2.
 *
 *   2. `createStateHasher(probe)` — v2-capable path. Callers that
 *      can probe both URL and DOM (e.g. CDP-attached tools) supply a
 *      `StateGraphProbe`. The hasher tries v2 first; when the
 *      skeleton probe is absent / returns null / throws, it falls
 *      through to v1 so the caller always gets *some* hash if a URL
 *      is available.
 *
 * In both shapes, the entire path is gated on
 * `isStateGraphEnabled()`. When the family flag is off the returned
 * thunk is a no-op that yields `null` without invoking the
 * underlying providers.
 *
 * Failure handling:
 *   - A throwing / rejecting URL provider yields `null`. The
 *     runtime's always-settles guarantee is preserved.
 *   - A throwing / rejecting skeleton probe falls through to v1 (no
 *     skeleton, URL-only). It does NOT yield `null` — the caller
 *     still wants a coarse anchor when the structural probe is
 *     unreliable, and v1 is the conservative choice.
 */

import { isStateGraphEnabled } from '../../harness/flags.js';
import type { DomSkeleton } from './dom-skeleton.js';
import {
  computeNodeHash,
  computeNodeHashV2,
  type StateHashVersion,
} from './node-hash.js';

export type UrlProvider = () => string | null | undefined | Promise<string | null | undefined>;

export type SkeletonProvider = () => DomSkeleton | null | undefined | Promise<DomSkeleton | null | undefined>;

/**
 * Combined probe for v2 hashing. The `skeleton` member is optional —
 * a probe without skeleton degrades cleanly to v1.
 */
export interface StateGraphProbe {
  url: UrlProvider;
  skeleton?: SkeletonProvider;
}

/**
 * Result type emitted by the hasher. The runtime attaches `hash` to
 * `TransactionRecord.state_hash` and `version` to
 * `TransactionRecord.state_hash_version`, so audit log consumers can
 * tell which algorithm produced each anchor.
 */
export interface StateHashResult {
  hash: string;
  version: StateHashVersion;
}

function isProbe(input: UrlProvider | StateGraphProbe): input is StateGraphProbe {
  return typeof input === 'object' && input !== null && typeof input.url === 'function';
}

export function createStateHasher(
  input: UrlProvider | StateGraphProbe,
): () => Promise<StateHashResult | null> {
  return async () => {
    if (!isStateGraphEnabled()) return null;

    const getUrl: UrlProvider = isProbe(input) ? input.url : input;
    const getSkeleton: SkeletonProvider | undefined = isProbe(input) ? input.skeleton : undefined;

    let url: string | null | undefined;
    try {
      url = await getUrl();
    } catch {
      return null;
    }

    // Try v2 first when a skeleton provider is wired. A null /
    // throwing skeleton falls through to v1 rather than yielding
    // null: a coarse anchor is more useful than no anchor at all
    // for skill correlation.
    if (getSkeleton !== undefined) {
      let skeleton: DomSkeleton | null | undefined;
      try {
        skeleton = await getSkeleton();
      } catch {
        skeleton = null;
      }
      if (skeleton) {
        let v2: string | null;
        try {
          v2 = computeNodeHashV2(url, skeleton);
        } catch {
          v2 = null;
        }
        if (v2 !== null) return { hash: v2, version: 'v2' };
      }
    }

    const v1 = computeNodeHash(url);
    if (v1 === null) return null;
    return { hash: v1, version: 'v1' };
  };
}
