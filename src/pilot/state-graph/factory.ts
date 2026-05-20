/**
 * Factory for the runtime's `computeStateHash` callback.
 *
 * The contract runtime (`src/pilot/runtime/runtime.ts`) accepts an
 * optional `computeStateHash` hook on `ContractRuntimeArgs` and calls
 * it once per run, best-effort, after the pre-check has passed. The
 * runtime intentionally knows nothing about how the hash is computed —
 * it just attaches the returned string to the emitted
 * `TransactionRecord`.
 *
 * This factory is the recommended wiring: it gates the entire path
 * on `isStateGraphEnabled()` so when the family flag is off the
 * callback returns `null` without invoking the URL provider. Callers
 * pass a `getUrl()` thunk; v1 needs only the URL.
 *
 * Why a thunk and not a string:
 *   - The runtime invokes the callback once per `runWithContract`,
 *     and the URL may be resolved lazily (e.g., via a snapshot that
 *     hasn't fired yet at the call site).
 *   - It keeps the factory testable with a sync constant in unit
 *     tests and a real async URL probe in production wiring.
 *
 * Failure handling:
 *   - A `getUrl()` rejection is swallowed and the factory returns
 *     `null` so the runtime's always-settles guarantee remains
 *     intact. The runtime logs nothing on a `null` return — that is
 *     by design (see runtime.ts comment near the call site).
 */

import { isStateGraphEnabled } from '../../harness/flags.js';
import { computeNodeHash } from './node-hash.js';

export type UrlProvider = () => string | null | undefined | Promise<string | null | undefined>;

/**
 * Build the hasher callback. Returns a no-op (`null`-returning)
 * function when the state-graph family is disabled, so wiring is
 * unconditional at the call site and the gate check happens here.
 */
export function createStateHasher(getUrl: UrlProvider): () => Promise<string | null> {
  return async () => {
    if (!isStateGraphEnabled()) return null;
    let url: string | null | undefined;
    try {
      url = await getUrl();
    } catch {
      return null;
    }
    return computeNodeHash(url);
  };
}
