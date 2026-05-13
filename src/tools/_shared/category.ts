/**
 * Tool Category Taxonomy (#847)
 *
 * Each MCP tool registered by openchrome belongs to exactly one category.
 * Operators can opt out of categories at process start via:
 *   --slim
 *   --enable-categories=<csv>
 *   --disable-categories=<csv>
 * (or the equivalent OPENCHROME_* env vars).
 *
 * Why categories at all:
 *   The full surface ships ~65 tools. For small-context model deployments
 *   (Sonnet 4.6 / Haiku 4.5) and multi-MCP-server setups, the JSON-schema
 *   registration alone consumes a measurable fraction of the system prompt.
 *   chrome-devtools-mcp solves this with a `--slim` switch; we generalize
 *   that to a per-category opt-in/out at registration time.
 *
 * Boundary:
 *   `src/tools/index.ts` filters registration through `resolveEnabledCategories()`
 *   before invoking each register*Tool function. Skipped tools never appear in
 *   `tools/list` — discoverability lives in the sidecar MCP resource
 *   `openchrome://tools/disabled`.
 */

export type ToolCategory =
  | 'navigation'
  | 'interact'
  | 'inspect'
  | 'tabs'
  | 'workflow'
  | 'session'
  | 'capture'
  | 'emulation'
  | 'storage'
  | 'observe'
  | 'memory'
  | 'contracts'
  | 'vision'
  | 'crawl'
  | 'security'
  | 'host'
  | 'reliability'
  | 'pilot';

/**
 * The complete set of categories. Ordered for deterministic listing/serialization.
 */
export const ALL_CATEGORIES: readonly ToolCategory[] = [
  'navigation',
  'interact',
  'inspect',
  'tabs',
  'workflow',
  'session',
  'capture',
  'emulation',
  'storage',
  'observe',
  'memory',
  'contracts',
  'vision',
  'crawl',
  'security',
  'host',
  'reliability',
  'pilot',
] as const;

/**
 * Categories that are ALWAYS included regardless of operator selection.
 * An openchrome instance must remain diagnosable (`observe`) and its
 * lifecycle controllable (`reliability`); excluding these would produce a
 * server you cannot stop or inspect.
 */
export const ALWAYS_ON_CATEGORIES: readonly ToolCategory[] = [
  'reliability',
  'observe',
] as const;

/**
 * Slim allow-list — chrome-devtools-mcp parity, plus the two always-on
 * categories per resolution rule 4. Picked to cover the "navigate + read +
 * click + type" minimal coding-agent loop without pulling in capture/storage/
 * tabs management.
 */
export const SLIM_CATEGORIES: readonly ToolCategory[] = [
  'navigation',
  'interact',
  'inspect',
] as const;

/**
 * Canonical tool-name → category map.
 *
 * Every tool registered in `src/tools/index.ts` MUST have an entry here.
 * `scripts/lint-tool-categories.mjs` enforces this at CI time, and
 * `src/tools/_shared/category-map.test.ts` snapshots the full mapping so any
 * future tool addition forces the author to pick a category (test-fail).
 *
 * Names are taken verbatim from the `name:` field of each tool's
 * `MCPToolDefinition` (i.e. the MCP-visible name).
 */
export const TOOL_TO_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  // navigation
  navigate: 'navigation',
  page_reload: 'navigation',
  wait_for: 'navigation',

  // interact
  interact: 'interact',
  computer: 'interact',
  find: 'interact',
  form_input: 'interact',
  fill_form: 'interact',
  act: 'interact',
  drag_drop: 'interact',
  file_upload: 'interact',

  // inspect
  read_page: 'inspect',
  page_content: 'inspect',
  query_dom: 'inspect',
  inspect: 'inspect',
  javascript_tool: 'inspect',
  extract_data: 'inspect',

  // tabs
  tabs_create: 'tabs',
  tabs_close: 'tabs',
  tabs_context: 'tabs',
  worker: 'tabs',
  worker_update: 'tabs',

  // workflow
  workflow_init: 'workflow',
  workflow_status: 'workflow',
  workflow_collect: 'workflow',
  workflow_collect_partial: 'workflow',
  workflow_cleanup: 'workflow',
  worker_complete: 'workflow',
  execute_plan: 'workflow',
  batch_execute: 'workflow',
  batch_paginate: 'workflow',
  lightweight_scroll: 'workflow',

  // session
  oc_session_snapshot: 'session',
  oc_session_resume: 'session',
  oc_context_export: 'session',
  oc_context_import: 'session',
  oc_checkpoint: 'session',
  oc_profile_status: 'session',
  list_profiles: 'session',

  // capture
  page_screenshot: 'capture',
  page_pdf: 'capture',
  oc_recording_start: 'capture',
  oc_recording_stop: 'capture',
  oc_recording_status: 'capture',
  oc_recording_list: 'capture',
  oc_recording_export: 'capture',

  // emulation
  emulate_device: 'emulation',
  user_agent: 'emulation',
  geolocation: 'emulation',
  network: 'emulation',
  network_capture_lite: 'emulation',
  network_capture_full: 'emulation',
  request_intercept: 'emulation',

  // storage
  cookies: 'storage',
  storage: 'storage',
  http_auth: 'storage',

  // observe (always-on)
  console_capture: 'observe',
  performance_metrics: 'observe',
  oc_journal: 'observe',
  oc_connection_health: 'observe',
  oc_doctor_report: 'observe',
  oc_performance_insights: 'observe',
  oc_performance_analyze: 'observe',
  oc_observe: 'observe',

  // memory
  memory: 'memory',
  oc_skill_record: 'memory',
  oc_skill_recall: 'memory',

  // contracts
  oc_assert: 'contracts',
  oc_evidence_bundle: 'contracts',

  // vision
  vision_find: 'vision',

  // crawl
  crawl: 'crawl',
  crawl_sitemap: 'crawl',
  crawl_start: 'crawl',
  crawl_status: 'crawl',
  crawl_cancel: 'crawl',

  // security
  oc_totp_generate: 'security',

  // host
  oc_get_connection_info: 'host',
  oc_devtools_url: 'host',
  oc_copy_to_clipboard: 'host',
  oc_open_host_settings: 'host',

  // reliability (always-on)
  validate_page: 'reliability',
  oc_stop: 'reliability',
  oc_reap_orphans: 'reliability',
  oc_proxy_hook: 'pilot',
  oc_skill_replay: 'pilot',
};

/**
 * Operator-supplied selection. All fields optional; if all three are
 * undefined the resolver returns the full set (default behavior — byte-
 * identical to v1.11.0).
 */
export interface CategorySelection {
  /** Allow-list. If set, only these categories are enabled (before always-on union). */
  enabled?: readonly ToolCategory[];
  /** Deny-list. Applied AFTER `enabled`/`slim`. Always-on categories cannot be removed. */
  disabled?: readonly ToolCategory[];
  /** Shortcut for `enabled = SLIM_CATEGORIES`. Wins over `enabled` if both set. */
  slim?: boolean;
}

/**
 * Resolve the final set of enabled categories per the rules in #847:
 *   1. If `slim`, ignore `enabled` and start from SLIM_CATEGORIES.
 *   2. Else apply `enabled` as the working set (default = ALL_CATEGORIES).
 *   3. Subtract `disabled`.
 *   4. Force-include ALWAYS_ON_CATEGORIES regardless of selection.
 *
 * The returned set is deterministic (Set with insertion order matching
 * ALL_CATEGORIES) so callers can snapshot it.
 */
export function resolveEnabledCategories(
  selection: CategorySelection = {},
): Set<ToolCategory> {
  let working: Set<ToolCategory>;

  if (selection.slim) {
    working = new Set(SLIM_CATEGORIES);
  } else if (selection.enabled && selection.enabled.length > 0) {
    working = new Set(selection.enabled);
  } else {
    working = new Set(ALL_CATEGORIES);
  }

  if (selection.disabled && selection.disabled.length > 0) {
    for (const cat of selection.disabled) {
      working.delete(cat);
    }
  }

  // Always-on union — applied last so neither --disable-categories nor an
  // overly narrow --enable-categories can take down the diagnostic surface.
  for (const cat of ALWAYS_ON_CATEGORIES) {
    working.add(cat);
  }

  // Re-emit in canonical order for deterministic snapshots.
  const ordered = new Set<ToolCategory>();
  for (const cat of ALL_CATEGORIES) {
    if (working.has(cat)) ordered.add(cat);
  }
  return ordered;
}

/**
 * Validate that a CSV string contains only known categories. Returns the
 * parsed array on success; throws on unknown category. Trims whitespace and
 * filters empty segments. Used by both CLI flag parsing and the env-var
 * fallback so error messages are consistent.
 */
export function parseCategoryCsv(raw: string, source: string): ToolCategory[] {
  const known = new Set<ToolCategory>(ALL_CATEGORIES);
  const out: ToolCategory[] = [];
  const seen = new Set<string>();
  for (const rawSegment of raw.split(',')) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (!known.has(segment as ToolCategory)) {
      throw new Error(
        `[${source}] Unknown tool category "${segment}". Known categories: ${ALL_CATEGORIES.join(', ')}`,
      );
    }
    if (!seen.has(segment)) {
      seen.add(segment);
      out.push(segment as ToolCategory);
    }
  }
  return out;
}

/**
 * Operator-facing description of how categories interact with selection.
 * Wired into `--help` so the `--slim` / `--enable-categories` /
 * `--disable-categories` flags are self-documenting.
 */
export function categoryHelpText(): string {
  return [
    'Tool categories (use with --slim / --enable-categories / --disable-categories):',
    `  ${ALL_CATEGORIES.join(', ')}`,
    `  Always-on (cannot be disabled): ${ALWAYS_ON_CATEGORIES.join(', ')}`,
    `  --slim shortcut → enabled = ${SLIM_CATEGORIES.join(', ')} (plus always-on)`,
  ].join('\n');
}
