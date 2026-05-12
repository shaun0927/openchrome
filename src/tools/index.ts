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
  oc_assert: 'core',
  oc_checkpoint: 'core',
  oc_connection_health: 'core',
  oc_copy_to_clipboard: 'core',
  oc_evidence_bundle: 'core',
  oc_get_connection_info: 'core',
  oc_journal: 'core',
  oc_open_host_settings: 'core',
  oc_reap_orphans: 'core',
  oc_session_resume: 'core',
  oc_session_snapshot: 'core',
  oc_skill_recall: 'core',
  oc_skill_record: 'core',
  oc_stop: 'core',
  page_content: 'core',
  page_pdf: 'core',
  page_reload: 'core',
  page_screenshot: 'core',
  performance_metrics: 'core',
  query_dom: 'core',
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
  worker_complete: 'crawl',
  worker_update: 'crawl',

  // recording — session recording
  oc_recording_export: 'recording',
  oc_recording_list: 'recording',
  oc_recording_start: 'recording',
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
};

/**
 * Thin proxy around MCPServer that injects the capability field from
 * TOOL_CAPABILITY_MAP into every MCPToolDefinition at registerTool() time.
 *
 * This keeps capability metadata in one authoritative location (this file)
 * without requiring every individual tool file to know about capability groups.
 */
class CapabilityInjectingServer {
  constructor(private readonly server: MCPServer) {}

  registerTool(
    name: string,
    handler: ToolHandler,
    definition: MCPToolDefinition,
    options?: { timeoutRecoverable?: boolean },
  ): void {
    const capability: ToolCapability = TOOL_CAPABILITY_MAP[name] ?? 'core';
    this.server.registerTool(name, handler, { ...definition, capability }, options);
  }

  // Proxy all other MCPServer methods used by individual register* functions
  getToolNames(): string[] {
    return this.server.getToolNames();
  }
}

export function registerAllTools(server: MCPServer): void {
  // Wrap the real server so every registerTool() call gets a capability tag
  const proxy = new CapabilityInjectingServer(server);

  // Core browser tools
  registerNavigateTool(proxy as unknown as MCPServer);
  registerComputerTool(proxy as unknown as MCPServer);
  registerReadPageTool(proxy as unknown as MCPServer);
  registerFindTool(proxy as unknown as MCPServer);
  registerFormInputTool(proxy as unknown as MCPServer);
  registerJavascriptTool(proxy as unknown as MCPServer);
  registerNetworkTool(proxy as unknown as MCPServer);

  // Phase 1: Page and content tools
  registerPageReloadTool(proxy as unknown as MCPServer);
  registerCookiesTool(proxy as unknown as MCPServer);
  registerQueryDomTool(proxy as unknown as MCPServer);
  registerPageContentTool(proxy as unknown as MCPServer);
  registerWaitForTool(proxy as unknown as MCPServer);
  registerStorageTool(proxy as unknown as MCPServer);

  // Phase 2: Device emulation and settings
  registerUserAgentTool(proxy as unknown as MCPServer);
  registerGeolocationTool(proxy as unknown as MCPServer);
  registerEmulateDeviceTool(proxy as unknown as MCPServer);
  registerPagePdfTool(proxy as unknown as MCPServer);
  registerPageScreenshotTool(proxy as unknown as MCPServer);
  registerConsoleCaptureTool(proxy as unknown as MCPServer);
  registerPerformanceMetricsTool(proxy as unknown as MCPServer);
  registerRequestInterceptTool(proxy as unknown as MCPServer);

  // Phase 3: Advanced tools
  registerFileUploadTool(proxy as unknown as MCPServer);
  registerHttpAuthTool(proxy as unknown as MCPServer);
  registerDragDropTool(proxy as unknown as MCPServer);

  // UX improvement composite tools (reduce tool call count)
  registerFillFormTool(proxy as unknown as MCPServer);

  // Tab management
  registerTabsContextTool(proxy as unknown as MCPServer);
  registerTabsCreateTool(proxy as unknown as MCPServer);
  registerTabsCloseTool(proxy as unknown as MCPServer);

  // Worker management (parallel browser operations)
  registerWorkerTool(proxy as unknown as MCPServer);

  // Orchestration tools (Chrome-Sisyphus workflow management)
  registerOrchestrationTools(proxy as unknown as MCPServer);

  // Performance tools (P0 - eliminate agent spawn overhead & screenshot bottleneck)
  registerBatchExecuteTool(proxy as unknown as MCPServer);
  registerLightweightScrollTool(proxy as unknown as MCPServer);
  registerBatchPaginateTool(proxy as unknown as MCPServer);

  // Smart Tools (reduce LLM wandering — response enrichment + composite tools)
  registerInteractTool(proxy as unknown as MCPServer);
  registerInspectTool(proxy as unknown as MCPServer);

  // Vision tools (vision-based element discovery #577)
  registerVisionFindTool(proxy as unknown as MCPServer);

  // Memory tools (domain knowledge persistence)
  registerMemoryTools(proxy as unknown as MCPServer);

  // Lifecycle tools
  registerShutdownTool(proxy as unknown as MCPServer);
  registerReapOrphansTool(proxy as unknown as MCPServer);
  registerProfileStatusTool(proxy as unknown as MCPServer);
  registerListProfilesTool(proxy as unknown as MCPServer);

  // AI Agent Continuity tools (#355, #356)
  registerSessionSnapshotTool(proxy as unknown as MCPServer);
  registerSessionResumeTool(proxy as unknown as MCPServer);
  registerJournalTool(proxy as unknown as MCPServer);

  // Self-healing tools (#347)
  registerConnectionHealthTool(proxy as unknown as MCPServer);

  // AI Agent Continuity tools (#347 Phase 4)
  registerCheckpointTool(proxy as unknown as MCPServer);

  // Web AI host connection tools (#523)
  registerConnectTools(proxy as unknown as MCPServer);

  // Session recording tools (#572)
  registerRecordingTools(proxy as unknown as MCPServer);

  // Crawl tools (#576)
  registerCrawlTool(proxy as unknown as MCPServer);
  registerCrawlSitemapTool(proxy as unknown as MCPServer);

  // Natural language action API (#578)
  registerActTool(proxy as unknown as MCPServer);

  // Composite page-health check (#token-efficiency)
  registerValidatePageTool(proxy as unknown as MCPServer);

  // Structured extraction (#571)
  registerExtractDataTool(proxy as unknown as MCPServer);

  // 2FA tools (#575)
  registerTotpGenerateTool(proxy as unknown as MCPServer);

  // Outcome Contracts (#784) — single-call assertion verifier
  registerOcAssertTool(proxy as unknown as MCPServer);

  // Outcome Contracts (#792) — evidence bundle capture
  registerOcEvidenceBundleTool(proxy as unknown as MCPServer);

  // Skill memory tools (#785) — record + recall
  registerOcSkillRecordTool(proxy as unknown as MCPServer);
  registerOcSkillRecallTool(proxy as unknown as MCPServer);

  console.error(`[Tools] Registered ${server.getToolNames().length} tools`);
}
