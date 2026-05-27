/**
 * Default outcome contract template registry (A2-PR6 of #1359).
 *
 * Single-process singleton seeded with the four public-web templates
 * (page-meta, spa-hydrated, link-graph, authenticated-fields). Tool
 * handlers that accept a `contract_id` / `template_id` look up against
 * this registry without each handler having to instantiate its own.
 *
 * The default registry is **read-mostly**: callers should treat
 * `getDefaultTemplateRegistry()` as a frozen handle and avoid
 * registering new templates after first use. Test helpers can call
 * `resetDefaultTemplateRegistryForTests()` to rebuild a clean
 * instance.
 *
 * Per #1359 §P2 (harness, not agent): the registry is *data*, not
 * runtime behavior. Hosts that need additional templates clone the
 * registry pattern in their own code rather than mutating the
 * default.
 */

import { PAGE_META_TEMPLATE } from './public-web/page-meta';
import { SPA_HYDRATED_TEMPLATE } from './public-web/spa-hydrated';
import { LINK_GRAPH_TEMPLATE } from './public-web/link-graph';
import { AUTHENTICATED_FIELDS_TEMPLATE } from './public-web/authenticated-fields';
import { TemplateRegistry } from './registry';

let _default: TemplateRegistry | null = null;

function buildDefault(): TemplateRegistry {
  const r = new TemplateRegistry();
  r.register(PAGE_META_TEMPLATE);
  r.register(SPA_HYDRATED_TEMPLATE);
  r.register(LINK_GRAPH_TEMPLATE);
  r.register(AUTHENTICATED_FIELDS_TEMPLATE);
  return r;
}

/**
 * Lazy-initialized singleton. The first caller pays the construction
 * cost; subsequent callers receive the same instance.
 */
export function getDefaultTemplateRegistry(): TemplateRegistry {
  if (_default === null) _default = buildDefault();
  return _default;
}

/**
 * Rebuild the default registry from scratch. Intended for tests that
 * want a known-clean state.
 */
export function resetDefaultTemplateRegistryForTests(): void {
  _default = null;
}
