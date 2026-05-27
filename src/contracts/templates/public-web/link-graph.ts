/**
 * public-web.link-graph — outcome contract template (A2-PR4 of #1359).
 *
 * Declares the canonical schema for *site-crawl link-graph extraction* —
 * the Tier-1 task family that proves a crawl tool ranges over a site and
 * preserves the relationship between pages.
 *
 * The schema captures graph identity (root, nodeCount, edgeCount,
 * maxDepth) and policy (sameOrigin) so two runs can be diffed for
 * coverage without shipping the raw node/edge arrays in the schema-diff
 * layer. The raw `nodes` and `edges` arrays are also declared so the
 * host can verify their presence and type, but the schema does not
 * impose a content-level shape — host-supplied schemas (or oc_diff)
 * handle that.
 *
 * Wire format is schema-diff.v1.
 *
 * Per #1359 §P4 the template is data only. The host runs the crawl
 * (crawl_start / crawl_status / find / extract_data) and presents the
 * shaped graph to the bundle writer under this schema's identity.
 */

import type { OutcomeTemplate } from '../types';

export const LINK_GRAPH_TEMPLATE: OutcomeTemplate = {
  id: 'public-web.link-graph',
  version: 1,
  description:
    'Tier-1 site-crawl link-graph extraction: root, nodes (url+title), ' +
    'edges (from→to), maxDepth, sameOrigin policy. The minimum shape every ' +
    'crawl task surfaces so two runs can be diffed for coverage without ' +
    'shipping the raw node/edge arrays in the schema-diff layer.',
  tags: ['public-web', 'crawl', 'graph', 'tier-1'],
  targetSchema: {
    format: 'schema-diff.v1',
    definition: {
      version: 1,
      fields: [
        // ── Identity / policy ─────────────────────────────────────────
        { name: 'root', type: 'string' },
        { name: 'sameOrigin', type: 'boolean' },

        // ── Graph cardinality (load-bearing for coverage diff) ────────
        { name: 'nodeCount', type: 'number' },
        { name: 'edgeCount', type: 'number' },
        { name: 'maxDepth', type: 'number' },

        // ── Raw payload presence (host validates content via oc_diff) ─
        // The host extracts these arrays. We declare them as array
        // buckets so schema-diff confirms shape; content-level
        // verification belongs in a stricter contract supplied by the
        // host or in oc_diff.
        { name: 'nodes', type: 'array' },
        { name: 'edges', type: 'array' },

        // ── Optional enrichments ──────────────────────────────────────
        // Wall-clock duration the crawl took. Optional because some
        // host execution paths (replay, mock) don't measure it.
        { name: 'durationMs', type: 'number', required: false },

        // Robots / disallow signals encountered. Optional.
        { name: 'robotsBlocked.count', type: 'number', required: false },

        // Worker / queue diagnostics that some crawlers emit.
        { name: 'frontierSize.final', type: 'number', required: false },
      ],
    },
  },
};
