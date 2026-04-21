// Scope -> tool mapping for API-key authentication (issue #9).
//
// Classification rule of thumb:
//   - ADMIN_TOOLS: admin-keys-* family. Empty for now; PR3 adds entries.
//   - READ_TOOLS: explicit allow-list of non-mutating tools (safe for read-only
//     API keys). Anything that only inspects page/tab/session state.
//   - WRITE_TOOLS: anything that can change browser/tab state, navigate,
//     mutate the DOM, fill or submit forms, set cookies/storage, run JS,
//     or trigger network/file-upload side effects. Also includes composite
//     tools whose subactions can mutate (e.g. `worker` with create/delete,
//     `memory` with record/validate).
//   - Unknown tools default to 'write' (least-privilege fail-safe): a new
//     tool added without updating this file will reject read-only keys
//     instead of silently granting them mutation capability.
//
// Scope implication: admin > write > read. 'headless-only' is an
// AND-constraint the caller must enforce separately; it is not in the
// implication chain.

import type { Scope } from './api-key-types';

export type ToolId = string;

export const READ_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  // Page/DOM inspection
  'read_page',
  'page_content',
  'page_screenshot',
  'page_pdf',
  'query_dom',
  'find',
  'vision_find',
  'inspect',

  // Tab / session / profile introspection
  'tabs_context',
  'list_profiles',
  'oc_profile_status',
  'oc_get_connection_info',
  'oc_connection_health',
  'oc_journal',

  // Diagnostics / metrics
  'performance_metrics',
  'console_capture',
  'extract_data',
  'wait_for',

  // Workflow / recording read-only queries
  'workflow_status',
  'workflow_collect',
  'workflow_collect_partial',
  'oc_recording_list',
  'oc_recording_export',

  // Local, non-browser-mutating utilities
  'oc_totp_generate',
]);

export const WRITE_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  // User-facing interaction / mutation
  'act',
  'interact',
  'click',
  'type',
  'press',
  'scroll',
  'drag_drop',
  'lightweight_scroll',
  'fill_form',
  'form_input',
  'file_upload',
  'select_option',

  // Navigation / tab lifecycle
  'navigate',
  'page_reload',
  'tabs_create',
  'tabs_close',

  // Script / cookie / storage mutation
  'javascript_tool',
  'cookies',
  'storage',
  'http_auth',

  // Network / device emulation (side-effects on session)
  'network',
  'request_intercept',
  'emulate_device',
  'user_agent',
  'geolocation',

  // Server-side session lifecycle
  'oc_stop',
  'oc_session_resume',
  'oc_session_snapshot',
  'oc_checkpoint',

  // Orchestration (spawns workers, mutates workflow state)
  'workflow_init',
  'workflow_cleanup',
  'worker_update',
  'worker_complete',
  'execute_plan',

  // Composite tools whose subactions can mutate state
  'worker',   // create / delete subactions
  'memory',   // record / validate subactions

  // Recording lifecycle
  'oc_recording_start',
  'oc_recording_stop',

  // Host / clipboard mutations (affect the end-user environment)
  'oc_copy_to_clipboard',
  'oc_open_host_settings',

  // Automation actions that are effectively writes
  'computer',
  'batch_execute',
  'batch_paginate',
  'crawl',
  'crawl_sitemap',
]);

export const ADMIN_TOOLS: ReadonlySet<ToolId> = new Set<ToolId>([
  // PR3 will add: 'admin_keys_create', 'admin_keys_list', ...
]);

export function requiredScope(toolId: ToolId): Scope {
  if (ADMIN_TOOLS.has(toolId)) return 'admin';
  if (READ_TOOLS.has(toolId)) return 'read';
  // Default: WRITE_TOOLS members AND any unlisted/new tools require 'write'.
  // This fail-safes new composite tools (e.g. future `worker`-style additions)
  // against read-only keys bypassing the least-privilege boundary.
  return 'write';
}

export function isAllowed(toolId: ToolId, granted: readonly Scope[]): boolean {
  if (!granted || granted.length === 0) return false;
  const required = requiredScope(toolId);
  if (granted.includes('admin')) return true;
  if (required === 'admin') return false;
  if (granted.includes('write')) return true;
  if (required === 'write') return false;
  // required === 'read'
  return granted.includes('read');
}
