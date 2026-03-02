import type { ToolRouting } from '../types/browser-backend';

/**
 * Static mapping of all tool names to their backend routing preference.
 *
 * chrome-only: Tools that require Chrome capabilities (screenshots, PDF).
 * prefer-lightpanda: Tools that can run on Lightpanda for better performance.
 */
const TOOL_ROUTING_MAP: Record<string, ToolRouting> = {
  // Chrome-only tools (visual capabilities)
  computer: 'chrome-only',
  page_pdf: 'chrome-only',

  // Core tools - prefer-lightpanda
  navigate: 'prefer-lightpanda',
  read_page: 'prefer-lightpanda',
  find: 'prefer-lightpanda',
  form_input: 'prefer-lightpanda',
  javascript_tool: 'prefer-lightpanda',
  network: 'prefer-lightpanda',

  // Phase 1 tools - prefer-lightpanda
  page_reload: 'prefer-lightpanda',
  cookies: 'prefer-lightpanda',
  query_dom: 'prefer-lightpanda',
  page_content: 'prefer-lightpanda',
  wait_for: 'prefer-lightpanda',
  storage: 'prefer-lightpanda',

  // Phase 2 tools - prefer-lightpanda
  user_agent: 'prefer-lightpanda',
  geolocation: 'prefer-lightpanda',
  emulate_device: 'prefer-lightpanda',
  console_capture: 'prefer-lightpanda',
  performance_metrics: 'prefer-lightpanda',
  request_intercept: 'prefer-lightpanda',

  // Phase 3 tools - prefer-lightpanda
  file_upload: 'prefer-lightpanda',
  http_auth: 'prefer-lightpanda',
  drag_drop: 'prefer-lightpanda',

  // UX composite tools - prefer-lightpanda
  click_element: 'prefer-lightpanda',
  fill_form: 'prefer-lightpanda',
  wait_and_click: 'prefer-lightpanda',

  // Tab management tools - prefer-lightpanda
  tabs_context: 'prefer-lightpanda',
  tabs_create: 'prefer-lightpanda',
  tabs_close: 'prefer-lightpanda',

  // Worker management tool - prefer-lightpanda
  worker: 'prefer-lightpanda',

  // Memory tool - prefer-lightpanda
  memory: 'prefer-lightpanda',

  // Orchestration tools - prefer-lightpanda
  workflow_init: 'prefer-lightpanda',
  workflow_status: 'prefer-lightpanda',
  workflow_collect: 'prefer-lightpanda',
  workflow_cleanup: 'prefer-lightpanda',
};

export class ToolRoutingRegistry {
  /**
   * Returns the routing preference for a given tool name.
   * Unknown tools default to 'chrome-only' as a safe fallback.
   */
  static getRouting(toolName: string): ToolRouting {
    return TOOL_ROUTING_MAP[toolName] ?? 'chrome-only';
  }

  /**
   * Returns true if the tool requires Chrome (screenshot/PDF capability).
   */
  static isVisualTool(toolName: string): boolean {
    return TOOL_ROUTING_MAP[toolName] === 'chrome-only';
  }

  /**
   * Returns the list of all chrome-only tool names.
   */
  static getChromeOnlyTools(): string[] {
    return Object.entries(TOOL_ROUTING_MAP)
      .filter(([, routing]) => routing === 'chrome-only')
      .map(([name]) => name);
  }

  /**
   * Returns the list of all prefer-lightpanda tool names.
   */
  static getPreferLightpandaTools(): string[] {
    return Object.entries(TOOL_ROUTING_MAP)
      .filter(([, routing]) => routing === 'prefer-lightpanda')
      .map(([name]) => name);
  }
}
