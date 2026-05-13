/**
 * Tool Registry - Registers all MCP tools
 */

import { MCPServer } from '../mcp-server';
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
import { isProxyHookEnabled, isSkillReplayEnabled } from '../harness/flags';
// oc_observe (#866) — deterministic actionable-element enumeration
import { registerOcObserveTool } from './oc-observe';
// DevTools URL tool (#860) — expose Chrome DevTools inspector URLs
import { registerOcDevToolsUrlTool } from './oc-devtools-url';
// Portable context envelope (#873) — export/import surface
import { registerOcContextTools } from './oc-context';
import { isRunHarnessEnabled } from '../run-harness/flags';
import { registerRunHarnessTools } from '../run-harness/tools';

export function registerAllTools(server: MCPServer): void {
  // Core browser tools
  registerNavigateTool(server);
  registerComputerTool(server);
  registerReadPageTool(server);
  registerFindTool(server);
  registerFormInputTool(server);
  registerJavascriptTool(server);
  registerNetworkTool(server);

  // Phase 1: Page and content tools
  registerPageReloadTool(server);
  registerCookiesTool(server);
  registerQueryDomTool(server);
  registerPageContentTool(server);
  registerWaitForTool(server);
  registerStorageTool(server);

  // Phase 2: Device emulation and settings
  registerUserAgentTool(server);
  registerGeolocationTool(server);
  registerEmulateDeviceTool(server);
  registerPagePdfTool(server);
  registerPageScreenshotTool(server);
  registerConsoleCaptureTool(server);
  registerPerformanceMetricsTool(server);
  registerRequestInterceptTool(server);

  // Passive network capture (#896) — lite=headers-only, full=bodies-with-cap.
  // Coexists with request_intercept (which owns setRequestInterception(true)).
  registerNetworkCaptureLiteTool(server);
  registerNetworkCaptureFullTool(server);

  // Phase 3: Advanced tools
  registerFileUploadTool(server);
  registerHttpAuthTool(server);
  registerDragDropTool(server);

  // UX improvement composite tools (reduce tool call count)
  registerFillFormTool(server);

  // Tab management
  registerTabsContextTool(server);
  registerTabsCreateTool(server);
  registerTabsCloseTool(server);

  // Worker management (parallel browser operations)
  registerWorkerTool(server);

  // Orchestration tools (Chrome-Sisyphus workflow management)
  registerOrchestrationTools(server);

  // Performance tools (P0 - eliminate agent spawn overhead & screenshot bottleneck)
  registerBatchExecuteTool(server);
  registerLightweightScrollTool(server);
  registerBatchPaginateTool(server);

  // Smart Tools (reduce LLM wandering — response enrichment + composite tools)
  registerInteractTool(server);
  registerInspectTool(server);

  // Vision tools (vision-based element discovery #577)
  registerVisionFindTool(server);

  // Memory tools (domain knowledge persistence)
  registerMemoryTools(server);

  // Lifecycle tools
  registerShutdownTool(server);
  registerReapOrphansTool(server);
  registerProfileStatusTool(server);
  registerListProfilesTool(server);

  // AI Agent Continuity tools (#355, #356)
  registerSessionSnapshotTool(server);
  registerSessionResumeTool(server);
  registerJournalTool(server);

  // Self-healing tools (#347)
  registerConnectionHealthTool(server);

  // AI Agent Continuity tools (#347 Phase 4)
  registerCheckpointTool(server);

  // Web AI host connection tools (#523)
  registerConnectTools(server);

  // Session recording tools (#572)
  registerRecordingTools(server);

  // Crawl tools (#576)
  registerCrawlTool(server);
  registerCrawlSitemapTool(server);

  // Resumable host-driven crawl jobs (#886)
  registerCrawlStartTool(server);
  registerCrawlStatusTool(server);
  registerCrawlCancelTool(server);

  // Natural language action API (#578)
  registerActTool(server);

  // Composite page-health check (#token-efficiency)
  registerValidatePageTool(server);

  // Structured extraction (#571)
  registerExtractDataTool(server);

  // 2FA tools (#575)
  registerTotpGenerateTool(server);

  // Outcome Contracts (#784) — single-call assertion verifier
  registerOcAssertTool(server);

  // Outcome Contracts (#792) — evidence bundle capture
  registerOcEvidenceBundleTool(server);

  // Skill memory tools (#785) — record + recall
  registerOcSkillRecordTool(server);
  registerOcSkillRecallTool(server);
  // Skill replay (#856) — pilot-tier. Dynamically imported so no
  // `src/pilot/**` dependency is loaded unless --pilot and
  // OPENCHROME_SKILL_REPLAY=1 are both active.
  if (isSkillReplayEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { registerOcSkillReplayTool } = require('./oc-skill-replay') as typeof import('./oc-skill-replay');
    registerOcSkillReplayTool(server);
  }

  // Doctor report tool (#898) — read cached `openchrome doctor` output
  registerOcDoctorReportTool(server);
  // Performance insights two-step API (#846).
  // TODO(#844): use isCoreFeatureEnabled() helper once #844 lands.
  // Off-switch: when OPENCHROME_PERF_INSIGHTS=0 the two tools are NOT
  // registered, preserving v1.10.4 tools/list parity (P2). Default on.
  if (process.env.OPENCHROME_PERF_INSIGHTS !== '0') {
    registerOcPerformanceInsightsTool(server);
    registerOcPerformanceAnalyzeTool(server);
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
    registerOcProxyHookTool(server);
  }
  // oc_observe (#866) — deterministic actionable-element enumeration
  registerOcObserveTool(server);
  // DevTools URL tool (#860) — gated by OPENCHROME_EXPOSE_DEVTOOLS_URL !== '0'
  registerOcDevToolsUrlTool(server);
  // Portable context envelope (#873) — oc_context_export / oc_context_import
  registerOcContextTools(server);

  // Run harness (#1021) — opt-in tool-call event ledger.
  if (isRunHarnessEnabled()) {
    registerRunHarnessTools(server);
  }

  console.error(`[Tools] Registered ${server.getToolNames().length} tools`);
}
