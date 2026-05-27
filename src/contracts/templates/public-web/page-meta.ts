/**
 * public-web.page-meta — outcome contract template (A2-PR2 of #1359).
 *
 * Declares the canonical schema for *page-level meta extraction* — the
 * Tier-1 task family every web crawler needs and the smallest unit of
 * comparison for external benchmarks. Use this template when the host
 * agent wants oc_assert / oc_evidence_bundle to verify that an
 * extraction produced `{title, url, description, statusCode}` plus
 * Open Graph fields where present.
 *
 * Wire format is `schema-diff.v1` so the same JSON travels through:
 *   - oc_evidence_bundle's target_schema input (B1-PR2)
 *   - external benchmark scorers (airena, etc.)
 *
 * No detector / executor / heuristic is bundled — per #1359 §P4 the
 * template is data only. The host extracts the page (read_page,
 * extract_data, network response inspection) and presents the result
 * to the bundle writer under this schema's identity.
 */

import type { OutcomeTemplate } from '../types';

export const PAGE_META_TEMPLATE: OutcomeTemplate = {
  id: 'public-web.page-meta',
  version: 1,
  description:
    'Tier-1 page-level meta extraction: title, url, description, statusCode, ' +
    'Open Graph fields. The minimum schema every public-web crawl task must ' +
    'satisfy.',
  tags: ['public-web', 'meta', 'static', 'tier-1'],
  targetSchema: {
    format: 'schema-diff.v1',
    definition: {
      version: 1,
      fields: [
        // ── Required ─────────────────────────────────────────────────
        { name: 'title', type: 'string' },
        { name: 'url', type: 'string' },
        { name: 'statusCode', type: 'number' },

        // ── Optional ─────────────────────────────────────────────────
        // Description is conventionally required but missing on many
        // real-world pages. Mark optional so absence does not lower
        // coverage; the host can still detect omission via `missing`
        // when they want a stricter contract by overriding the
        // template inline.
        { name: 'description', type: 'string', required: false },

        // Open Graph (og:*) and Twitter Card fields — common
        // enrichments. Always optional in v1.
        { name: 'og.title', type: 'string', required: false },
        { name: 'og.description', type: 'string', required: false },
        { name: 'og.image', type: 'string', required: false },
        { name: 'og.type', type: 'string', required: false },
        { name: 'twitter.card', type: 'string', required: false },
      ],
    },
  },
};
