/**
 * Tool Registry - Registers all MCP tools
 *
 * Capability tagging (#829): every tool is assigned a capability group via
 * TOOL_CAPABILITY_MAP below. The CapabilityInjectingServer wrapper injects the
 * capability into each MCPToolDefinition at registerTool() time, so callers
 * never need to know about capability grouping — it is authoritative here.
 */

import { MCPServer } from '../mcp-server';
import type { ToolCapability, MCPToolDefinition, ToolHandler } from '../types/mcp';
import { registerNavigateTool } from './navigate';
import { registerComputerTool } from './computer';
import { registerReadPageTool } from './read-page';
import { registerFindTool } from './find';
import { registerFormInputTool } from './form-input';
import { registerJavascriptTool } from './javascript';
import { registerTabsContextTool } from './tabs-context';
import { registerTabsCreateTool } from './tabs-create';
import { registerTabsCloseTool } from './tabs-close';
import { registerNetworkTool } from './network';
import { registerWorkerTool } from './worker';
import { registerOrchestrationTools } from './orchestration';

// Phase 1 tools
import { registerPageReloadTool } from './page-reload';
import { registerCookiesTool } from './cookies';
import { registerPageContentTool } from './page-content';
import { registerWaitForTool } from './wait-for';
import { registerStorageTool } from './storage';

// Phase 2 tools
import { registerUserAgentTool } from './user-agent';
import { registerGeolocationTool } from './geolocation';
import { registerEmulateDeviceTool } from './emulate-device';
import { registerPagePdfTool } from './page-pdf';
import { registerPageScreenshotTool } from './page-screenshot';
import { registerConsoleCaptureTool } from './console-capture';
import { registerPerformanceMetricsTool } from './performance-metrics';
import { registerRequestInterceptTool } from './request-intercept';
import { registerNetworkCaptureLiteTool } from './network-capture-lite';
import { registerNetworkCaptureFullTool } from './network-capture-full';

// Phase 3 tools
import { registerFileUploadTool } from './file-upload';
import { registerHttpAuthTool } from './http-auth';
import { registerDragDropTool } from './drag-drop';
// UX improvement composite tools
import { registerFillFormTool } from './fill-form';

// Performance tools (P0)
import { registerBatchExecuteTool } from './batch-execute';
import { registerLightweightScrollTool } from './lightweight-scroll';
import { registerBatchPaginateTool } from './batch-paginate';

// Smart Tools (reduce LLM wandering)
import { registerInteractTool } from './interact';
import { registerInspectTool } from './inspect';

// Vision tools (vision-based element discovery #577)
import { registerVisionFindTool } from './vision-find';

// Memory tools (domain knowledge persistence)
import { registerMemoryTools } from './memory';

// Consolidated DOM query tool
import { registerQueryDomTool } from './query-dom';
import { registerOcQueryTool } from './oc-query';

// Lifecycle tools
import { registerShutdownTool } from './shutdown';
import { registerReapOrphansTool } from './reap-orphans';
import { registerProfileStatusTool } from './profile-status';
import { registerListProfilesTool } from './list-profiles';

// AI Agent Continuity tools (#355, #356)
import { registerSessionSnapshotTool } from './session-snapshot';
import { registerSessionResumeTool } from './session-resume';
import { registerJournalTool } from './journal';
import { registerOcReflectTool } from './oc-reflect';

// Self-healing tools (#347)
import { registerConnectionHealthTool } from './connection-health';
import { registerOcPolicyTool } from './oc-policy';

// AI Agent Continuity tools (#347 Phase 4)
import { registerCheckpointTool } from './checkpoint';

// Web AI host connection tools (#523)
import { registerConnectTools } from './connect';

// Session recording tools (#572)
import { registerRecordingTools } from './recording';

// Crawl tools (#576)
import { registerCrawlTool } from './crawl';
import { registerCrawlSitemapTool } from './crawl-sitemap';

// Resumable host-driven crawl jobs (#886)
import { registerCrawlStartTool } from './crawl-start';
import { registerCrawlStatusTool } from './crawl-status';
import { registerCrawlCancelTool } from './crawl-cancel';

// Natural language action API (#578)
import { registerActTool } from './act';

// Composite page-health check (#token-efficiency)
import { registerValidatePageTool } from './validate-page';

// Structured extraction (#571)
import { registerExtractDataTool } from './extract-data';

// 2FA tools (#575)
import { registerTotpGenerateTool } from './totp-generate';

// Outcome Contracts (#784) — single-call assertion verifier
import { registerOcAssertTool } from './oc-assert';

// Outcome Contracts (#792) — evidence bundle capture
import { registerOcEvidenceBundleTool } from './oc-evidence-bundle';

// Skill memory tools (#785) — record + recall
import { registerOcSkillRecordTool } from './oc-skill-record';
import { registerOcSkillRecallTool } from './oc-skill-recall';

// Async task ledger (#855) — start/list/get/cancel/wait for long-running tools
import { registerOcTaskStartTool, getTaskStore, setTaskStartupReapPromise } from './oc-task-start';
import { registerOcTaskListTool } from './oc-task-list';
import { registerOcTaskGetTool } from './oc-task-get';
import { registerOcTaskCancelTool } from './oc-task-cancel';
import { registerOcTaskWaitTool } from './oc-task-wait';
// Doctor report tool (#898) — read cached `openchrome doctor` output
import { registerOcDoctorReportTool } from './oc-doctor-report';
// Performance insights two-step API (#846)
// TODO(#844): use isCoreFeatureEnabled() helper once #844 lands
import { registerOcPerformanceInsightsTool } from './oc-performance-insights';
import { registerOcPerformanceAnalyzeTool } from './oc-performance-analyze';
import { getSessionManager } from '../session-manager';
import { getPerfTraceStore } from '../core/performance/insights/trace-store';
// Pilot-tier: user-supplied proxy hook (#874).
// Registration is gated at runtime by `isProxyHookEnabled()` so the tool is
// absent from `tools/list` unless BOTH `--pilot` AND `OPENCHROME_PROXY_HOOK=1`
// are set. The pilot module is loaded via `require()` only when the gate is
// open — this preserves P2 (no module from `src/pilot/**` is loaded into the
// process when `--pilot` is unset) while keeping `registerAllTools()` sync.
import { isContractRuntimeEnabled, isProxyHookEnabled, isSkillReplayEnabled, isTruthy } from '../harness/flags';
// oc_observe (#866) — deterministic actionable-element enumeration
import { registerOcObserveTool } from './oc-observe';
// DevTools URL tool (#860) — expose Chrome DevTools inspector URLs
import { registerOcDevToolsUrlTool } from './oc-devtools-url';
// Portable context envelope (#873) — export/import surface
import { registerOcContextTools } from './oc-context';
// Action schema normalizer (#1062) — side-effect-free diagnostics.
import { registerOcNormalizeActionTool } from './oc-normalize-action';
import { isRunHarnessEnabled } from '../run-harness/flags';
import { registerRunHarnessTools } from '../run-harness/tools';
// Goal-level TaskRun lifecycle (#1039)
import { registerTaskRunTools } from './task-run';
// Read-only progress diagnostics (#1060).
import { registerOcProgressStatusTool } from './oc-progress-status';
// Web Vitals snapshot (#840).
import { registerOcVitalsTool } from './oc-vitals';
// 2-stage large-output fetch (#887) — store + paging tool.
import { registerOcOutputFetchTool } from './oc-output-fetch';
import { registerOcPilotRunWithRecoveryTool } from './oc-pilot-run-with-recovery';
import { getHandleStore } from '../core/output/handle-store';


/**
 * Authoritative capability map for every registered tool (#829).
 *
 * Groups:
 *   core      — fundamental browser control & session management
 *   storage   — cookie and web-storage access
 *   profile   — Chrome profile management
 *   crawl     — multi-page crawling, batch pagination, worker coordination
 *   recording — session recording (start/stop/list/export)
 *   workflow  — Chrome-Sisyphus orchestration workflow
 *   totp      — 2FA / TOTP generation
 *   pilot     — experimental pilot-tier tools
 *
 * Absent entry → defaults to 'core' (P1 backward-compat).
 * lint:tools-capabilities enforces that every registered tool appears here.
 */
export const TOOL_CAPABILITY_MAP: Record<string, ToolCapability> = {
  // core — fundamental browser control
  act: 'core',
  computer: 'core',
  console_capture: 'core',
  drag_drop: 'core',
  emulate_device: 'core',
  expand_tools: 'core',
  extract_data: 'core',
  file_upload: 'core',
  fill_form: 'core',
  find: 'core',
  form_input: 'core',
  geolocation: 'core',
  http_auth: 'core',
  inspect: 'core',
  interact: 'core',
  javascript_tool: 'core',
  lightweight_scroll: 'core',
  memory: 'core',
  navigate: 'core',
  network: 'core',
  network_capture_full: 'core',
  network_capture_lite: 'core',
  oc_assert: 'core',
  oc_checkpoint: 'core',
  oc_context_export: 'core',
  oc_context_import: 'core',
  oc_connection_health: 'core',
  oc_policy: 'core',
  oc_copy_to_clipboard: 'core',
  oc_devtools_url: 'core',
  oc_doctor_report: 'core',
  oc_evidence_bundle: 'core',
  oc_get_connection_info: 'core',
  oc_journal: 'core',
  oc_observe: 'core',
  oc_open_host_settings: 'core',
  oc_output_fetch: 'core',
  oc_performance_analyze: 'core',
  oc_performance_insights: 'core',
  oc_reap_orphans: 'core',
  oc_session_resume: 'core',
  oc_session_snapshot: 'core',
  oc_skill_recall: 'core',
  oc_skill_record: 'core',
  oc_skill_replay: 'pilot',
  oc_stop: 'core',
  page_content: 'core',
  page_pdf: 'core',
  page_reload: 'core',
  page_screenshot: 'core',
  performance_metrics: 'core',
  query_dom: 'core',
  oc_query: 'core',
  read_page: 'core',
  request_intercept: 'core',
  tabs_close: 'core',
  tabs_context: 'core',
  tabs_create: 'core',
  user_agent: 'core',
  validate_page: 'core',
  vision_find: 'core',
  wait_for: 'core',
  worker: 'core',

  // storage — cookie and web-storage
  cookies: 'storage',
  storage: 'storage',

  // profile — Chrome profile management
  list_profiles: 'profile',
  oc_profile_status: 'profile',

  // crawl — multi-page crawling and batch workers
  batch_execute: 'crawl',
  batch_paginate: 'crawl',
  crawl: 'crawl',
  crawl_sitemap: 'crawl',
  crawl_cancel: 'crawl',
  crawl_start: 'crawl',
  crawl_status: 'crawl',
  worker_complete: 'crawl',
  worker_update: 'crawl',

  // recording — session recording
  oc_recording_export: 'recording',
  oc_recording_list: 'recording',
  oc_recording_start: 'recording',
  oc_recording_status: 'recording',
  oc_recording_stop: 'recording',

  // workflow — Chrome-Sisyphus orchestration
  execute_plan: 'workflow',
  workflow_cleanup: 'workflow',
  workflow_collect: 'workflow',
  workflow_collect_partial: 'workflow',
  workflow_init: 'workflow',
  workflow_status: 'workflow',

  // totp — 2FA / TOTP generation
  oc_totp_generate: 'totp',

  // pilot — experimental pilot-tier tools
  oc_pilot_handoff_create: 'pilot',
  oc_pilot_run_with_recovery: 'pilot',
  oc_pilot_handoff_redeem: 'pilot',
  oc_proxy_hook: 'pilot',

  // core — develop-era additions (#1062 normalize, #1060 progress, #1019
  // reflect, #855 task ledger, run-harness ledger). All are diagnostics or
  // ledger ops with no special filter group.
  oc_normalize_action: 'core',
  oc_progress_status: 'core',
  oc_vitals: 'core',
  oc_reflect: 'core',
  oc_run_events: 'core',
  oc_run_finish: 'core',
  oc_run_start: 'core',
  oc_run_status: 'core',
  oc_task_cancel: 'core',
  oc_task_get: 'core',
  oc_task_list: 'core',
  oc_task_run_checkpoint: 'core',
  oc_task_run_complete: 'core',
  oc_task_run_get: 'core',
  oc_task_run_list: 'core',
  oc_task_run_needs_help: 'core',
  oc_task_run_start: 'core',
  oc_task_run_update: 'core',
  oc_task_start: 'core',
  oc_task_wait: 'core',
};

/**
 * Build a proxy around MCPServer that injects the capability field from
 * TOOL_CAPABILITY_MAP into every MCPToolDefinition at registerTool() time.
 *
 * Uses a real ES Proxy so every other method/property on the underlying
 * MCPServer is forwarded automatically. The previous implementation listed
 * methods explicitly and required `as unknown as MCPServer` casts at every
 * call site, which would TypeError at runtime if a register* function ever
 * reached for an un-listed method.
 *
 * Keeping capability metadata in one authoritative location (this file)
 * means individual tool files do not need to know about capability groups.
 */
function makeCapabilityInjectingProxy(server: MCPServer): MCPServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (
          name: string,
          handler: ToolHandler,
          definition: MCPToolDefinition,
          options?: { timeoutRecoverable?: boolean },
        ): void => {
          const capability: ToolCapability = TOOL_CAPABILITY_MAP[name] ?? 'core';
          target.registerTool(name, handler, { ...definition, capability }, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}


export function registerAllTools(server: MCPServer): void {
  // Wrap the real server so every registerTool() call gets a capability tag.
  const proxy = makeCapabilityInjectingProxy(server);

  // Core browser tools
  registerNavigateTool(proxy);
  registerComputerTool(proxy);
  registerReadPageTool(proxy);
  registerFindTool(proxy);
  registerFormInputTool(proxy);
  registerJavascriptTool(proxy);
  registerNetworkTool(proxy);

  // Phase 1: Page and content tools
  registerPageReloadTool(proxy);
  registerCookiesTool(proxy);
  registerQueryDomTool(proxy);
  registerPageContentTool(proxy);
  registerWaitForTool(proxy);
  registerStorageTool(proxy);

  // Phase 2: Device emulation and settings
  registerUserAgentTool(proxy);
  registerGeolocationTool(proxy);
  registerEmulateDeviceTool(proxy);
  registerPagePdfTool(proxy);
  registerPageScreenshotTool(proxy);
  registerConsoleCaptureTool(proxy);
  registerPerformanceMetricsTool(proxy);
  registerRequestInterceptTool(proxy);

  // Passive network capture (#896) — lite=headers-only, full=bodies-with-cap.
  // Coexists with request_intercept (which owns setRequestInterception(true)).
  registerNetworkCaptureLiteTool(proxy);
  registerNetworkCaptureFullTool(proxy);

  // Phase 3: Advanced tools
  registerFileUploadTool(proxy);
  registerHttpAuthTool(proxy);
  registerDragDropTool(proxy);

  // UX improvement composite tools (reduce tool call count)
  registerFillFormTool(proxy);

  // Tab management
  registerTabsContextTool(proxy);
  registerTabsCreateTool(proxy);
  registerTabsCloseTool(proxy);

  // Worker management (parallel browser operations)
  registerWorkerTool(proxy);

  // Orchestration tools (Chrome-Sisyphus workflow management)
  registerOrchestrationTools(proxy);

  // Performance tools (P0 - eliminate agent spawn overhead & screenshot bottleneck)
  registerBatchExecuteTool(proxy);
  registerLightweightScrollTool(proxy);
  registerBatchPaginateTool(proxy);

  // Smart Tools (reduce LLM wandering — response enrichment + composite tools)
  registerInteractTool(proxy);
  registerInspectTool(proxy);

  // Vision tools (vision-based element discovery #577)
  registerVisionFindTool(proxy);

  // Memory tools (domain knowledge persistence)
  registerMemoryTools(proxy);

  // Semantic query tool (#1045)
  registerOcQueryTool(proxy);

  // Lifecycle tools
  registerShutdownTool(proxy);
  registerReapOrphansTool(proxy);
  registerProfileStatusTool(proxy);
  registerListProfilesTool(proxy);

  // AI Agent Continuity tools (#355, #356)
  registerSessionSnapshotTool(proxy);
  registerSessionResumeTool(proxy);
  registerJournalTool(proxy);
  registerOcReflectTool(proxy);

  // Self-healing tools (#347)
  registerConnectionHealthTool(proxy);
  registerOcPolicyTool(proxy);

  // AI Agent Continuity tools (#347 Phase 4)
  registerCheckpointTool(proxy);

  // Web AI host connection tools (#523)
  registerConnectTools(proxy);

  // Session recording tools (#572)
  registerRecordingTools(proxy);

  // Crawl tools (#576)
  registerCrawlTool(proxy);
  registerCrawlSitemapTool(proxy);

  // Resumable host-driven crawl jobs (#886)
  registerCrawlStartTool(proxy);
  registerCrawlStatusTool(proxy);
  registerCrawlCancelTool(proxy);

  // Natural language action API (#578)
  registerActTool(proxy);

  // Composite page-health check (#token-efficiency)
  registerValidatePageTool(proxy);

  // Structured extraction (#571)
  registerExtractDataTool(proxy);

  // 2FA tools (#575)
  registerTotpGenerateTool(proxy);

  // Outcome Contracts (#784) — single-call assertion verifier
  registerOcAssertTool(proxy);

  // Action schema normalizer (#1062) — no browser side effects.
  registerOcNormalizeActionTool(server);

  // Read-only anti-wandering diagnostics (#1060).
  registerOcProgressStatusTool(server);
  registerOcVitalsTool(proxy);

  // 2-stage large-output fetch (#887) — paging tool for handle payloads.
  registerOcOutputFetchTool(proxy);

  // Outcome Contracts (#792) — evidence bundle capture
  registerOcEvidenceBundleTool(proxy);

  // Skill memory tools (#785) — record + recall
  registerOcSkillRecordTool(proxy);
  registerOcSkillRecallTool(proxy);
  // Skill replay (#856) — pilot-tier. Dynamically imported so no
  // `src/pilot/**` dependency is loaded unless --pilot and
  // OPENCHROME_SKILL_REPLAY=1 are both active.
  if (isSkillReplayEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerOcSkillReplayTool: _reg } = require('./oc-skill-replay') as typeof import('./oc-skill-replay');
    _reg(proxy);
  }

  // Pilot contract runtime (#1061) — off unless --pilot and OPENCHROME_CONTRACT_RUNTIME are active.
  if (isContractRuntimeEnabled() && isTruthy(process.env.OPENCHROME_CONTRACT_RUNTIME)) {
    registerOcPilotRunWithRecoveryTool(proxy);
  }

  // P2 fix (#887): purge expired output handles every 5 minutes.
  // `.unref()` ensures the interval does not prevent clean process exit.
  const _outputPurgeTimer = setInterval(() => {
    const removed = getHandleStore().purgeExpired();
    if (removed > 0) {
      console.error(`[output-handles] Purged ${removed} expired handle(s)`);
    }
  }, 5 * 60 * 1000);
  _outputPurgeTimer.unref();

  // Async task ledger (#855) — persistent background task table
  registerOcTaskStartTool(server);
  registerOcTaskListTool(server);
  registerOcTaskGetTool(server);
  registerOcTaskCancelTool(server);
  registerOcTaskWaitTool(server);

  // Reap any RUNNING task whose owner pid is no longer alive. Runs
  // once at server start (issue #855 invariant #2) so a crash on a
  // previous boot transitions orphaned rows to FAILED before new
  // tasks are accepted. Best-effort: log and continue on failure.
  setTaskStartupReapPromise(
    getTaskStore()
      .reapOrphans()
      .then((reaped) => {
        if (reaped.length > 0) {
          console.error(`[task-ledger] Reaped ${reaped.length} orphaned task(s) at startup`);
        }
      }),
  );

  // Doctor report tool (#898) — read cached `openchrome doctor` output
  registerOcDoctorReportTool(proxy);
  // Performance insights two-step API (#846).
  // TODO(#844): use isCoreFeatureEnabled() helper once #844 lands.
  // Off-switch: when OPENCHROME_PERF_INSIGHTS=0 the two tools are NOT
  // registered, preserving v1.10.4 tools/list parity (P2). Default on.
  if (process.env.OPENCHROME_PERF_INSIGHTS !== '0') {
    registerOcPerformanceInsightsTool(proxy);
    registerOcPerformanceAnalyzeTool(proxy);
    // Wire session-scoped trace eviction once. The store keeps an
    // in-memory map of session_id -> trace_ids; on session deletion we
    // delete every trace file owned by that session.
    const sm = getSessionManager();
    const store = getPerfTraceStore();
    sm.addEventListener((event) => {
      if (event.type === 'session:deleted' && event.sessionId) {
        const removed = store.evictSession(event.sessionId);
        if (removed > 0) {
          console.error(
            `[PerfInsights] Evicted ${removed} trace handle(s) for session ${event.sessionId}`,
          );
        }
      }
    });
  }
  // Pilot-tier: user-supplied proxy hook (#874). Loaded lazily so v1.11
  // behaviour is byte-identical when the family is off — no code from
  // `src/pilot/**` is reached unless both `--pilot` and
  // `OPENCHROME_PROXY_HOOK=1` are set.
  if (isProxyHookEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerOcProxyHookTool } = require('../pilot/proxy/hook') as typeof import('../pilot/proxy/hook');
    registerOcProxyHookTool(proxy);
  }
  // oc_observe (#866) — deterministic actionable-element enumeration
  registerOcObserveTool(proxy);
  // DevTools URL tool (#860) — gated by OPENCHROME_EXPOSE_DEVTOOLS_URL !== '0'
  registerOcDevToolsUrlTool(proxy);
  // Portable context envelope (#873) — oc_context_export / oc_context_import
  registerOcContextTools(proxy);

  // Run harness (#1021) — opt-in tool-call event ledger.
  if (isRunHarnessEnabled()) {
    registerRunHarnessTools(server);
  }

  // Goal-level TaskRun lifecycle (#1039) — opt-in, no effect on existing tools.
  registerTaskRunTools(server);

  console.error(`[Tools] Registered ${server.getToolNames().length} tools`);
}
