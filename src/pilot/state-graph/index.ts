/**
 * Pilot state-graph family — barrel export.
 *
 * Ships two coexisting algorithm generations distinguished by
 * `STATE_HASH_VERSION`:
 *
 *   - v1 (URL-only): `computeNodeHash(url)`. Used by callers without
 *     CDP access in scope (the legacy `createStateHasher(getUrl)`
 *     overload). Stable across algorithm bumps.
 *   - v2 (URL + DOM skeleton): `computeNodeHashV2(url, skeleton)`.
 *     Used by callers wiring a `StateGraphProbe` with a `skeleton()`
 *     method — typically CDP-attached tools.
 *
 * Both versions are emitted with their version tag on every
 * `TransactionRecord` so curator migrations, audit dashboards, and
 * future v3 generations can distinguish lineage without re-parsing
 * historical frontmatter.
 *
 * Activation: this module is only loaded into the process when
 * `--pilot` is enabled and `isStateGraphEnabled()` returns true. Per
 * the portability-harness contract, no code from `src/pilot/**` is
 * pulled into core builds.
 */

export {
  STATE_HASH_VERSION,
  canonicalizeUrl,
  computeNodeHash,
  computeNodeHashV2,
} from './node-hash.js';

export type { StateHashVersion } from './node-hash.js';

export {
  bucketCount,
  canonicalizeSkeleton,
  normaliseSkeleton,
} from './dom-skeleton.js';

export type {
  DomSkeleton,
  DomSkeletonCounts,
  DomSkeletonNode,
} from './dom-skeleton.js';

export { createStateHasher } from './factory.js';
export type {
  SkeletonProvider,
  StateGraphProbe,
  StateHashResult,
  UrlProvider,
} from './factory.js';
