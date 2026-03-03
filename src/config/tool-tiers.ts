/**
 * Tool Tier Configuration
 *
 * Controls which tools are exposed by default vs on-demand.
 * Tier 1: Always exposed (core tools for every session)
 * Tier 2: Exposed on demand (specialist/niche tools)
 * Tier 3: Orchestration only (workflow lifecycle tools)
 */

export type ToolTier = 1 | 2 | 3;

/** Map of tool name → tier assignment */
export const TOOL_TIERS: Record<string, ToolTier> = {
  // Tier 1: Core (always exposed)
  navigate: 1,
  page_reload: 1,
  computer: 1,
  interact: 1,
  find: 1,
  form_input: 1,
  fill_form: 1,
  read_page: 1,
  inspect: 1,
  query_dom: 1,
  javascript_tool: 1,
  tabs_context: 1,
  tabs_create: 1,
  tabs_close: 1,
  cookies: 1,
  storage: 1,
  wait_for: 1,
  memory: 1,
  lightweight_scroll: 1,
  oc_stop: 1,
  oc_profile_status: 1,

  // Tier 2: Specialist (on demand)
  click_element: 2,
  wait_and_click: 2,
  drag_drop: 2,
  network: 2,
  request_intercept: 2,
  http_auth: 2,
  user_agent: 2,
  geolocation: 2,
  emulate_device: 2,
  page_pdf: 2,
  page_content: 2,
  console_capture: 2,
  performance_metrics: 2,
  file_upload: 2,
  batch_execute: 2,
  batch_paginate: 2,

  // Tier 3: Orchestration only
  workflow_init: 3,
  workflow_status: 3,
  workflow_collect: 3,
  workflow_collect_partial: 3,
  workflow_cleanup: 3,
  worker: 3,
  worker_update: 3,
  worker_complete: 3,
  execute_plan: 3,
};

/** Get the tier for a tool (defaults to 1 if not configured) */
export function getToolTier(toolName: string): ToolTier {
  return TOOL_TIERS[toolName] ?? 1;
}
