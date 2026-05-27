/**
 * public-web.spa-hydrated — outcome contract template (A2-PR3 of #1359).
 *
 * Declares the canonical schema for *post-hydration SPA extraction* —
 * the Tier-1 task family that proves a real-Chrome harness is worth the
 * cost over a static fetch. Use this template when the host agent runs
 * a single-page app (React/Vue/Next/Angular) through full hydration and
 * extracts the post-rendered content.
 *
 * The schema captures what every SPA observer cares about regardless of
 * framework:
 *
 *   - The post-hydration page identity (title, url, route).
 *   - A characterization of mainContent so callers can diff hydration
 *     coverage across runs (length, has headings, structured data
 *     presence).
 *   - Readiness signals so the host can confirm hydration completed
 *     before the snapshot was taken.
 *
 * Wire format is schema-diff.v1, identical to public-web.page-meta —
 * downstream consumers (oc_evidence_bundle, external scorers) treat
 * the two templates interchangeably at the diff level.
 *
 * Per #1359 §P4 the template is data only. The host extracts the
 * post-hydration page (read_page after wait_for stable, query_dom,
 * extract_data) and presents the result to the bundle writer under
 * this schema's identity.
 */

import type { OutcomeTemplate } from '../types';

export const SPA_HYDRATED_TEMPLATE: OutcomeTemplate = {
  id: 'public-web.spa-hydrated',
  version: 1,
  description:
    'Tier-1 single-page-app extraction: title, url, route, post-hydration ' +
    'mainContent characterization, readiness signals, and any structured-data ' +
    'blocks emitted by the framework after hydration.',
  tags: ['public-web', 'spa', 'dynamic', 'tier-1'],
  targetSchema: {
    format: 'schema-diff.v1',
    definition: {
      version: 1,
      fields: [
        // ── Page identity ─────────────────────────────────────────────
        { name: 'title', type: 'string' },
        { name: 'url', type: 'string' },

        // SPA route (the client-side router's current path). May equal
        // window.location.pathname or may be a hash route. Required
        // because the whole point of SPA hydration is to surface this.
        { name: 'route', type: 'string' },

        // ── Main content characterization ─────────────────────────────
        // Don't ship the raw mainContent text in the schema — it varies
        // wildly across runs and would tank coverage on every retry.
        // Instead capture deterministic features the host can diff.
        { name: 'mainContent.length', type: 'number' },
        { name: 'mainContent.hasHeadings', type: 'boolean' },

        // ── Readiness signals ─────────────────────────────────────────
        // Required: prove hydration actually completed when the snapshot
        // was taken. domStable=false should be treated as
        // "extraction may be partial."
        { name: 'readiness.domStable', type: 'boolean' },
        { name: 'readiness.framework', type: 'string' },

        // ── Optional enrichments ──────────────────────────────────────
        // Description (when the framework wires meta tags into the SSR
        // payload — many SPAs ship blank descriptions).
        { name: 'description', type: 'string', required: false },

        // Structured data blocks (JSON-LD, microdata). Optional because
        // not every SPA emits them.
        { name: 'structuredData', type: 'array', required: false },
        { name: 'structuredData.count', type: 'number', required: false },

        // Open Graph / Twitter Card mirrors of page-meta for sites that
        // hydrate them client-side.
        { name: 'og.title', type: 'string', required: false },
        { name: 'og.description', type: 'string', required: false },
        { name: 'og.image', type: 'string', required: false },
        { name: 'twitter.card', type: 'string', required: false },
      ],
    },
  },
};
