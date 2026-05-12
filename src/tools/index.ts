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
 * names that calling `register()` will produce; the entry is invoked iff at
 * least one of those names belongs to an enabled category.
 *
 * Granularity intentionally matches the original `registerAllTools` body —
 * we don't fan out multi-tool registrars (e.g. orchestration, recording,
 * connect) into per-tool entries because the registrar is a unit of code
 * cost, not a unit of selection. Per-tool selection is achieved by the fact
 * that EVERY tool produced by the registrar shares the same category in the
 * canonical map; the lint script enforces total coverage.
 */
interface RegistrationEntry {
  /** MCP names produced by `register`. Must all be present in TOOL_TO_CATEGORY. */
  tools: readonly string[];
  register: (server: MCPServer) => void;
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
      if (process.env.OPENCHROME_PERF_INSIGHTS === '0') return;
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

  for (const entry of REGISTRATION_ENTRIES) {
    // A registrar is invoked iff EVERY tool it produces belongs to an
    // enabled category. Multi-tool registrars whose names span categories
    // would normally be a smell — but TOOL_TO_CATEGORY is verified by the
    // lint script + snapshot test to assign one canonical category per
    // name, so in practice every multi-tool registrar in this file shares
    // a single category among its outputs (orchestration → workflow,
    // recording → capture, connect → host).
    let allEnabled = true;
    for (const name of entry.tools) {
      const cat = TOOL_TO_CATEGORY[name];
      if (cat === undefined) {
        // Misconfiguration — fail loud at startup so a missing category
        // assignment never silently slips into production. Mirrors the
        // CI lint check (scripts/lint-tool-categories.mjs).
        throw new Error(
          `[Tools] Tool "${name}" has no category in TOOL_TO_CATEGORY. ` +
            `Add it to src/tools/_shared/category.ts.`,
        );
      }
      if (!enabled.has(cat)) {
        allEnabled = false;
      }
    }

    if (allEnabled) {
      entry.register(server);
    } else {
      // Record every individual tool the registrar would have produced as
      // disabled, with its own category-specific restart hint. We surface
      // ALL skipped names here, even ones whose category happens to be
      // enabled (in case a future multi-tool registrar bundles tools across
      // categories) — an operator can then read the resource and see
      // exactly what's missing and why.
      for (const name of entry.tools) {
        const cat = TOOL_TO_CATEGORY[name] as ToolCategory;
        disabledEntries.push({
          name,
          category: cat,
          hint: buildDisabledHint(cat),
        });
      }
    }
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
