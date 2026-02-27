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
import { registerWorkerCreateTool } from './worker-create';
import { registerWorkerListTool } from './worker-list';
import { registerWorkerDeleteTool } from './worker-delete';
import { registerOrchestrationTools } from './orchestration';

// Phase 1 tools
import { registerPageReloadTool } from './page-reload';
import { registerCookiesTool } from './cookies';
import { registerSelectorQueryTool } from './selector-query';
import { registerPageContentTool } from './page-content';
import { registerWaitForTool } from './wait-for';
import { registerStorageTool } from './storage';

// Phase 2 tools
import { registerUserAgentTool } from './user-agent';
import { registerGeolocationTool } from './geolocation';
import { registerEmulateDeviceTool } from './emulate-device';
import { registerPagePdfTool } from './page-pdf';
import { registerConsoleCaptureTool } from './console-capture';
import { registerPerformanceMetricsTool } from './performance-metrics';
import { registerRequestInterceptTool } from './request-intercept';

// Phase 3 tools
import { registerXpathQueryTool } from './xpath-query';
import { registerFileUploadTool } from './file-upload';
import { registerHttpAuthTool } from './http-auth';
import { registerDragDropTool } from './drag-drop';

// UX improvement composite tools
import { registerClickElementTool } from './click-element';
import { registerFillFormTool } from './fill-form';
import { registerWaitAndClickTool } from './wait-and-click';

// Performance tools (P0)
import { registerBatchExecuteTool } from './batch-execute';
import { registerLightweightScrollTool } from './lightweight-scroll';
import { registerBatchPaginateTool } from './batch-paginate';

// Smart Tools (reduce LLM wandering)
import { registerInteractTool } from './interact';
import { registerInspectTool } from './inspect';

// Memory tools (domain knowledge persistence)
import { registerMemoryTools } from './memory';

// Lifecycle tools
import { registerShutdownTool } from './shutdown';
import { registerProfileStatusTool } from './profile-status';

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
  registerSelectorQueryTool(server);
  registerPageContentTool(server);
  registerWaitForTool(server);
  registerStorageTool(server);

  // Phase 2: Device emulation and settings
  registerUserAgentTool(server);
  registerGeolocationTool(server);
  registerEmulateDeviceTool(server);
  registerPagePdfTool(server);
  registerConsoleCaptureTool(server);
  registerPerformanceMetricsTool(server);
  registerRequestInterceptTool(server);

  // Phase 3: Advanced tools
  registerXpathQueryTool(server);
  registerFileUploadTool(server);
  registerHttpAuthTool(server);
  registerDragDropTool(server);

  // UX improvement composite tools (reduce tool call count)
  registerClickElementTool(server);
  registerFillFormTool(server);
  registerWaitAndClickTool(server);

  // Tab management
  registerTabsContextTool(server);
  registerTabsCreateTool(server);
  registerTabsCloseTool(server);

  // Worker management (parallel browser operations)
  registerWorkerCreateTool(server);
  registerWorkerListTool(server);
  registerWorkerDeleteTool(server);

  // Orchestration tools (Chrome-Sisyphus workflow management)
  registerOrchestrationTools(server);

  // Performance tools (P0 - eliminate agent spawn overhead & screenshot bottleneck)
  registerBatchExecuteTool(server);
  registerLightweightScrollTool(server);
  registerBatchPaginateTool(server);

  // Smart Tools (reduce LLM wandering — response enrichment + composite tools)
  registerInteractTool(server);
  registerInspectTool(server);

  // Memory tools (domain knowledge persistence)
  registerMemoryTools(server);

  // Lifecycle tools
  registerShutdownTool(server);
  registerProfileStatusTool(server);

  console.error(`[Tools] Registered ${server.getToolNames().length} tools`);
}
