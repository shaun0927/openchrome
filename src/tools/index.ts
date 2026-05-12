/**
 * Tool Registry — Registers all MCP tools, gated by category selection (#847).
 *
 * Each register*Tool entry below is paired with the MCP-visible name(s) it
 * adds and the category that gates it. The pair is consulted before invoking
 * the registrar, so disabled categories never touch `server.registerTool()` —
 * the disabled name does not appear in `tools/list` or in any cached tool
 * manifest, exactly matching chrome-devtools-mcp `--slim` semantics.
 *
 * Default behavior (no category flags) is byte-identical to v1.11.0; pinned
 * by `tests/tools/registration-default.snapshot.test.ts`.
 */

import { MCPServer } from '../mcp-server';
import {
  CategorySelection,
  resolveEnabledCategories,
  TOOL_TO_CATEGORY,
  ToolCategory,
} from './_shared/category';
import {
  buildDisabledHint,
  setDisabledToolsSnapshot,
  DisabledToolEntry,
} from '../resources/tools-disabled';
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

// Lifecycle tools
import { registerShutdownTool } from './shutdown';
import { registerReapOrphansTool } from './reap-orphans';
import { registerProfileStatusTool } from './profile-status';
import { registerListProfilesTool } from './list-profiles';

// AI Agent Continuity tools (#355, #356)
import { registerSessionSnapshotTool } from './session-snapshot';
import { registerSessionResumeTool } from './session-resume';
import { registerJournalTool } from './journal';

// Self-healing tools (#347)
import { registerConnectionHealthTool } from './connection-health';

// AI Agent Continuity tools (#347 Phase 4)
import { registerCheckpointTool } from './checkpoint';

// Web AI host connection tools (#523)
import { registerConnectTools } from './connect';

// Session recording tools (#572)
import { registerRecordingTools } from './recording';

// Crawl tools (#576)
import { registerCrawlTool } from './crawl';
import { registerCrawlSitemapTool } from './crawl-sitemap';

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
import { isProxyHookEnabled } from '../harness/flags';
// oc_observe (#866) — deterministic actionable-element enumeration
import { registerOcObserveTool } from './oc-observe';
// DevTools URL tool (#860) — expose Chrome DevTools inspector URLs
import { registerOcDevToolsUrlTool } from './oc-devtools-url';
// Portable context envelope (#873) — export/import surface
import { registerOcContextTools } from './oc-context';

/**
 * One entry per registrar invocation. `tools` is the list of MCP-visible
 * names that calling `register()` will produce.
 *
 * Selection is per-TOOL, not per-registrar: a registrar that emits tools
 * across multiple categories (e.g. orchestration emits `worker_update` in
 * `tabs` and `workflow_*` in `workflow`) is still invoked, and the proxy
 * server passed to it silently drops the individual `registerTool()` calls
 * whose category is disabled. The `tools` list is preserved here both for
 * the category lint (`scripts/lint-tool-categories.mjs` parses it) and so
 * the disabled-tools sidecar resource can report the exact names that were
 * filtered out, with category-specific restart hints.
 */
interface RegistrationEntry {
  /** MCP names produced by `register`. Must all be present in TOOL_TO_CATEGORY. */
  tools: readonly string[];
  register: (server: MCPServer) => void;
}

/**
 * Build a `MCPServer` proxy that delegates `registerTool` only when the
 * tool's category is in the enabled set. Every other property/method is
 * forwarded untouched. Disabled tools are appended to `disabledOut` so the
 * caller can publish them on the sidecar resource.
 *
 * Why a Proxy instead of editing each `registerXxx(server)` callsite:
 *   - A registrar may emit tools in DIFFERENT categories (orchestration ⇒
 *     `tabs` + `workflow`). The pre-#944 "all-or-nothing per registrar"
 *     branch silently dropped workflow_* tools when only `tabs` was
 *     disabled. The proxy makes the filter run per individual tool, which
 *     restores the contract advertised by --disable-categories.
 *   - Keeps every existing registrar untouched: they keep calling
 *     `server.registerTool(...)` exactly as before.
 */
function makeFilteredServer(
  server: MCPServer,
  enabled: Set<ToolCategory>,
  disabledOut: DisabledToolEntry[],
): MCPServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return function filteredRegisterTool(
          this: unknown,
          name: string,
          ...rest: unknown[]
        ): void {
          const category = TOOL_TO_CATEGORY[name];
          if (category === undefined) {
            // Misconfiguration — fail loud at startup so a missing category
            // assignment never silently slips into production. Mirrors the
            // CI lint check (scripts/lint-tool-categories.mjs).
            throw new Error(
              `[Tools] Tool "${name}" has no category in TOOL_TO_CATEGORY. ` +
                `Add it to src/tools/_shared/category.ts.`,
            );
          }
          if (!enabled.has(category)) {
            disabledOut.push({
              name,
              category,
              hint: buildDisabledHint(category),
            });
            return;
          }
          // Forward to the real registerTool. We invoke via the underlying
          // method bound to `target` so internal `this` references resolve
          // against the real server, not the proxy.
          const original = Reflect.get(target, prop, target) as (
            ...args: unknown[]
          ) => void;
          original.call(target, name, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const REGISTRATION_ENTRIES: readonly RegistrationEntry[] = [
  // Core browser tools
  { tools: ['navigate'], register: registerNavigateTool },
  { tools: ['computer'], register: registerComputerTool },
  { tools: ['read_page'], register: registerReadPageTool },
  { tools: ['find'], register: registerFindTool },
  { tools: ['form_input'], register: registerFormInputTool },
  { tools: ['javascript_tool'], register: registerJavascriptTool },
  { tools: ['network'], register: registerNetworkTool },

  // Phase 1: Page and content tools
  { tools: ['page_reload'], register: registerPageReloadTool },
  { tools: ['cookies'], register: registerCookiesTool },
  { tools: ['query_dom'], register: registerQueryDomTool },
  { tools: ['page_content'], register: registerPageContentTool },
  { tools: ['wait_for'], register: registerWaitForTool },
  { tools: ['storage'], register: registerStorageTool },

  // Phase 2: Device emulation and settings
  { tools: ['user_agent'], register: registerUserAgentTool },
  { tools: ['geolocation'], register: registerGeolocationTool },
  { tools: ['emulate_device'], register: registerEmulateDeviceTool },
  { tools: ['page_pdf'], register: registerPagePdfTool },
  { tools: ['page_screenshot'], register: registerPageScreenshotTool },
  { tools: ['console_capture'], register: registerConsoleCaptureTool },
  { tools: ['performance_metrics'], register: registerPerformanceMetricsTool },
  { tools: ['request_intercept'], register: registerRequestInterceptTool },

  // Passive network capture (#896) — lite=headers-only, full=bodies-with-cap.
  // Coexists with request_intercept (which owns setRequestInterception(true)).
  { tools: ['network_capture_lite'], register: registerNetworkCaptureLiteTool },
  { tools: ['network_capture_full'], register: registerNetworkCaptureFullTool },

  // Phase 3: Advanced tools
  { tools: ['file_upload'], register: registerFileUploadTool },
  { tools: ['http_auth'], register: registerHttpAuthTool },
  { tools: ['drag_drop'], register: registerDragDropTool },

  // UX improvement composite tools
  { tools: ['fill_form'], register: registerFillFormTool },

  // Tab management
  { tools: ['tabs_context'], register: registerTabsContextTool },
  { tools: ['tabs_create'], register: registerTabsCreateTool },
  { tools: ['tabs_close'], register: registerTabsCloseTool },

  // Worker management
  { tools: ['worker'], register: registerWorkerTool },

  // Orchestration tools (multi-tool registrar)
  {
    tools: [
      'workflow_init',
      'workflow_status',
      'workflow_collect',
      'workflow_collect_partial',
      'workflow_cleanup',
      'worker_update',
      'worker_complete',
      'execute_plan',
    ],
    register: registerOrchestrationTools,
  },

  // Performance tools
  { tools: ['batch_execute'], register: registerBatchExecuteTool },
  { tools: ['lightweight_scroll'], register: registerLightweightScrollTool },
  { tools: ['batch_paginate'], register: registerBatchPaginateTool },

  // Smart Tools
  { tools: ['interact'], register: registerInteractTool },
  { tools: ['inspect'], register: registerInspectTool },

  // Vision tools
  { tools: ['vision_find'], register: registerVisionFindTool },

  // Memory tools
  { tools: ['memory'], register: registerMemoryTools },

  // Lifecycle tools
  { tools: ['oc_stop'], register: registerShutdownTool },
  { tools: ['oc_reap_orphans'], register: registerReapOrphansTool },
  { tools: ['oc_profile_status'], register: registerProfileStatusTool },
  { tools: ['list_profiles'], register: registerListProfilesTool },

  // AI Agent Continuity tools
  { tools: ['oc_session_snapshot'], register: registerSessionSnapshotTool },
  { tools: ['oc_session_resume'], register: registerSessionResumeTool },
  { tools: ['oc_journal'], register: registerJournalTool },

  // Self-healing tools
  { tools: ['oc_connection_health'], register: registerConnectionHealthTool },

  // AI Agent Continuity (#347 Phase 4)
  { tools: ['oc_checkpoint'], register: registerCheckpointTool },

  // Web AI host connection tools (multi-tool registrar)
  {
    tools: [
      'oc_get_connection_info',
      'oc_copy_to_clipboard',
      'oc_open_host_settings',
    ],
    register: registerConnectTools,
  },

  // Session recording tools (multi-tool registrar)
  {
    tools: [
      'oc_recording_start',
      'oc_recording_stop',
      'oc_recording_list',
      'oc_recording_export',
    ],
    register: registerRecordingTools,
  },

  // Crawl tools
  { tools: ['crawl'], register: registerCrawlTool },
  { tools: ['crawl_sitemap'], register: registerCrawlSitemapTool },

  // Natural language action API
  { tools: ['act'], register: registerActTool },

  // Composite page-health check
  { tools: ['validate_page'], register: registerValidatePageTool },

  // Structured extraction
  { tools: ['extract_data'], register: registerExtractDataTool },

  // 2FA tools
  { tools: ['oc_totp_generate'], register: registerTotpGenerateTool },

  // Outcome Contracts
  { tools: ['oc_assert'], register: registerOcAssertTool },
  { tools: ['oc_evidence_bundle'], register: registerOcEvidenceBundleTool },

  // Skill memory tools
  { tools: ['oc_skill_record'], register: registerOcSkillRecordTool },
  { tools: ['oc_skill_recall'], register: registerOcSkillRecallTool },

  // Doctor report tool (#898)
  { tools: ['oc_doctor_report'], register: registerOcDoctorReportTool },

  // Performance insights two-step API (#846)
  {
    tools: ['oc_performance_insights', 'oc_performance_analyze'],
    register: (server) => {
      if (process.env.OPENCHROME_PERF_INSIGHTS !== '0') {
        registerOcPerformanceInsightsTool(server);
        registerOcPerformanceAnalyzeTool(server);
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
    },
  },

  // Pilot-tier: user-supplied proxy hook (#874).
  {
    tools: ['oc_proxy_hook'],
    register: (server) => {
      if (!isProxyHookEnabled()) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { registerOcProxyHookTool } = require('../pilot/proxy/hook') as typeof import('../pilot/proxy/hook');
      registerOcProxyHookTool(server);
    },
  },

  // Deterministic observation / DevTools / portable context
  { tools: ['oc_observe'], register: registerOcObserveTool },
  { tools: ['oc_devtools_url'], register: registerOcDevToolsUrlTool },
  { tools: ['oc_context_export', 'oc_context_import'], register: registerOcContextTools },
];

/**
 * Register all tools, gated by the supplied category selection.
 *
 * Selection sources are resolved by the CLI layer (src/cli.ts) and
 * collapsed into a single `CategorySelection` here — this function knows
 * nothing about flags or env vars, so it is trivially testable.
 *
 * Default behavior (`selection` undefined or all fields unset) is the full
 * surface, byte-identical to v1.11.0 — pinned by snapshot tests.
 */
export function registerAllTools(
  server: MCPServer,
  selection: CategorySelection = {},
): void {
  const enabled = resolveEnabledCategories(selection);
  const disabledEntries: DisabledToolEntry[] = [];

  // Pre-validate every advertised tool name has a category assignment. We
  // do this up front (rather than only during the proxy's registerTool
  // dispatch) so a missing TOOL_TO_CATEGORY entry on a registrar that
  // happens to be category-disabled still fails loud at startup, exactly
  // as the v1.11.0 unconditional registration path did.
  for (const entry of REGISTRATION_ENTRIES) {
    for (const name of entry.tools) {
      if (TOOL_TO_CATEGORY[name] === undefined) {
        throw new Error(
          `[Tools] Tool "${name}" has no category in TOOL_TO_CATEGORY. ` +
            `Add it to src/tools/_shared/category.ts.`,
        );
      }
    }
  }

  // Per-tool filtering: every registrar is invoked, but the proxy server
  // it receives silently drops registerTool() calls whose category is
  // disabled. This restores the per-category filtering contract for
  // registrars that emit tools across multiple categories (e.g.
  // orchestration → `worker_update` is `tabs`, `workflow_*` is `workflow`).
  const filteredServer = makeFilteredServer(server, enabled, disabledEntries);
  for (const entry of REGISTRATION_ENTRIES) {
    entry.register(filteredServer);
  }

  // Publish the disabled-tools snapshot to the sidecar resource so agents
  // can introspect what was dropped. Empty list when no flags are set —
  // that is the load-bearing default and forms part of the v1.11.0 parity
  // contract.
  setDisabledToolsSnapshot(disabledEntries);

  const enabledCats = Array.from(enabled).join(', ');
  const skipped = disabledEntries.length;
  console.error(
    `[Tools] Registered ${server.getToolNames().length} tools ` +
      `(categories: ${enabledCats}; skipped: ${skipped})`,
  );

}
