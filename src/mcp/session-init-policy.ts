/**
 * Tools in this set must remain available without MCPServer eagerly creating
 * a browser session. Most are diagnostics, lifecycle, orchestration metadata,
 * or local artifact operations. A small number of lifecycle handlers may
 * connect to Chrome themselves when their requested action requires it; the
 * important contract here is that the generic pre-handler session bootstrap
 * does not launch Chrome on their behalf.
 */
const SESSION_INIT_EXEMPT_TOOLS = new Set([
  'expand_tools',

  // Lifecycle and recovery surfaces that must work while CDP is unavailable.
  'oc_stop',
  'oc_reap_orphans',
  'oc_profile_status',
  'oc_session_snapshot',
  'oc_session_resume',
  'oc_journal',
  'oc_checkpoint',

  // Browser-free diagnostics and host integration.
  'oc_connection_health',
  'oc_doctor_report',
  'oc_get_connection_info',
  'oc_devtools_url',
  'list_profiles',
  'oc_normalize_action',
  'oc_policy',
  'oc_copy_to_clipboard',
  'oc_open_host_settings',

  // Local artifact, memory, and analysis operations.
  'memory',
  'image_qa',
  'oc_assert',
  'oc_diff',
  'oc_evidence_bundle',
  'oc_evidence_get',
  'oc_journal_compact',
  'oc_output_fetch',
  'oc_performance_analyze',
  'oc_reflect',
  'oc_skill_record',
  'oc_skill_recall',
  'oc_skill_export',
  'oc_totp_generate',

  // Recording metadata is local and can begin before the first browser call.
  'oc_recording_start',
  'oc_recording_stop',
  'oc_recording_status',
  'oc_recording_list',
  'oc_recording_export',

  // Persistent task/run ledgers never require Chrome directly.
  'oc_task_start',
  'oc_task_list',
  'oc_task_get',
  'oc_task_cancel',
  'oc_task_wait',
  'oc_task_update',
  'oc_task_finish',
  'oc_run_start',
  'oc_run_status',
  'oc_run_events',
  'oc_run_finish',
  'oc_progress_status',
  'oc_task_run_start',
  'oc_task_run_update',
  'oc_task_run_checkpoint',
  'oc_task_run_needs_help',
  'oc_task_run_complete',
  'oc_task_run_get',
  'oc_task_run_list',

  // Resumable crawl metadata. crawl_status is argument-sensitive below.
  'crawl_start',
  'crawl_cancel',

  // Orchestration state and cleanup operate on existing workers/artifacts.
  'workflow_status',
  'workflow_collect',
  'workflow_collect_partial',
  'workflow_cleanup',
  'worker_update',
  'worker_complete',

  // Lane inspection/cleanup must not create a new browser just to report or
  // dispose existing state. oc_lane_create remains browser-requiring.
  'oc_lane_list',
  'oc_lane_get',
  'oc_lane_close',

  // Pilot-local control planes persist or mutate process-local state only.
  'oc_credentials',
  'oc_proxy_hook',
  'oc_pilot_handoff_create',
  'oc_pilot_handoff_redeem',
]);

function crawlStatusRequiresBrowser(args: Readonly<Record<string, unknown>>): boolean {
  if (args.advance == null || !Number.isFinite(Number(args.advance))) {
    // Match crawl_status's default-advance behavior: omitted/invalid values
    // execute crawl work rather than acting as a read-only status call.
    return true;
  }
  return Math.max(0, Math.floor(Number(args.advance))) > 0;
}

function workerRequiresBrowser(args: Readonly<Record<string, unknown>>): boolean {
  // Missing required arguments are rejected before this policy is consulted.
  // Unknown actions are handler errors and should not launch Chrome.
  return args.action === 'create';
}

export function shouldInitializeBrowserSession(
  toolName: string,
  args: Readonly<Record<string, unknown>> = {},
): boolean {
  if (toolName === 'crawl_status') return crawlStatusRequiresBrowser(args);
  if (toolName === 'worker') return workerRequiresBrowser(args);
  return !SESSION_INIT_EXEMPT_TOOLS.has(toolName);
}
