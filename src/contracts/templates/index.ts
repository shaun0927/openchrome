/**
 * Public surface of the Outcome Contract Template subsystem (A2 thread).
 *
 * Concrete templates (page-meta, spa-hydrated, link-graph,
 * authenticated-fields) ship in follow-up PRs and re-export here.
 */

export type {
  OutcomeTemplate,
  OutcomeTemplateSchema,
} from './types';
export {
  DuplicateTemplateError,
  InvalidTemplateError,
} from './types';
export type { TemplateListing } from './registry';
export { TemplateRegistry } from './registry';

// ── public-web template catalog (A2-PR2..5 of #1359) ──────────────────────
export { PAGE_META_TEMPLATE } from './public-web/page-meta';
