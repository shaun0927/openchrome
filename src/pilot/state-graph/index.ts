/**
 * Pilot state-graph family — barrel export.
 *
 * v1 ships URL-only node hashing (`canonicalize(url)`), with the
 * algorithm version pinned at `STATE_HASH_VERSION = 'v1'`. DOM
 * skeleton folding lands in a follow-up PR and will bump the version
 * tag, so downstream consumers (curator migrations, dashboards) can
 * distinguish algorithm generations without re-parsing historical
 * frontmatter.
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
} from './node-hash.js';

export type { StateHashVersion } from './node-hash.js';

export { createStateHasher } from './factory.js';
export type { UrlProvider } from './factory.js';
