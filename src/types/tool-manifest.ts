/**
 * Tool Manifest Types - Shared Tool Registry for worker agents
 *
 * Enables workflow_init to export registered tool schemas so that
 * worker agents can skip ToolSearch and call tools immediately.
 */

/** A single tool entry in the manifest */
export interface ToolEntry {
  /** Full MCP tool name (e.g. "navigate", "javascript_tool") */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for tool parameters */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tool category for filtering */
  category: ToolCategory;
}

/** Tool categories for WorkerToolConfig filtering */
export type ToolCategory =
  | 'navigation'      // navigate, page_reload
  | 'interaction'     // computer, click_element, form_input, fill_form, drag_drop
  | 'content'         // read_page, find, page_content, selector_query, xpath_query
  | 'javascript'      // javascript_tool
  | 'network'         // network, cookies, storage, request_intercept, http_auth
  | 'tabs'            // tabs_context, tabs_create, tabs_close
  | 'media'           // page_pdf, console_capture, performance_metrics, file_upload
  | 'emulation'       // user_agent, geolocation, emulate_device
  | 'orchestration'   // workflow_init, workflow_status, workflow_collect, etc.
  | 'worker'          // worker_create, worker_list, worker_delete
  | 'composite'       // click_element, fill_form, wait_and_click, wait_for
  | 'performance'     // batch_execute, lightweight_scroll
  | 'lifecycle';      // ccp_stop

/** The complete tool manifest exported by the MCP server */
export interface ToolManifest {
  /** Manifest version for cache invalidation */
  version: string;
  /** Generation timestamp */
  generatedAt: number;
  /** All registered tools */
  tools: ToolEntry[];
  /** Total tool count */
  toolCount: number;
}

/** Per-worker tool access configuration */
export interface WorkerToolConfig {
  /** Worker type determines default tool set */
  workerType: 'extraction' | 'interaction' | 'full';
  /** Allowed tool categories (whitelist) */
  allowedCategories?: ToolCategory[];
  /** Specific tools to include regardless of category */
  additionalTools?: string[];
  /** Specific tools to exclude regardless of category */
  excludedTools?: string[];
}

/** Default tool sets per worker type */
export const DEFAULT_WORKER_TOOLS: Record<WorkerToolConfig['workerType'], ToolCategory[]> = {
  extraction: ['javascript', 'content', 'composite'],
  interaction: ['navigation', 'interaction', 'content', 'javascript', 'composite'],
  full: [
    'navigation', 'interaction', 'content', 'javascript',
    'network', 'tabs', 'media', 'emulation', 'composite', 'performance',
  ],
};

/**
 * Filter manifest tools based on WorkerToolConfig
 */
export function filterToolsForWorker(
  manifest: ToolManifest,
  config: WorkerToolConfig
): ToolEntry[] {
  const allowedCategories = config.allowedCategories || DEFAULT_WORKER_TOOLS[config.workerType];

  let tools = manifest.tools.filter(t => allowedCategories.includes(t.category));

  // Add specific additional tools
  if (config.additionalTools?.length) {
    const additional = manifest.tools.filter(
      t => config.additionalTools!.includes(t.name) && !tools.some(existing => existing.name === t.name)
    );
    tools = [...tools, ...additional];
  }

  // Remove excluded tools
  if (config.excludedTools?.length) {
    tools = tools.filter(t => !config.excludedTools!.includes(t.name));
  }

  return tools;
}
