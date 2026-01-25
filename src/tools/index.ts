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
import { registerNetworkTool } from './network';
import { registerWorkerCreateTool } from './worker-create';
import { registerWorkerListTool } from './worker-list';
import { registerWorkerDeleteTool } from './worker-delete';
import { registerOrchestrationTools } from './orchestration';

export function registerAllTools(server: MCPServer): void {
  // Core browser tools
  registerNavigateTool(server);
  registerComputerTool(server);
  registerReadPageTool(server);
  registerFindTool(server);
  registerFormInputTool(server);
  registerJavascriptTool(server);
  registerNetworkTool(server);

  // Tab management
  registerTabsContextTool(server);
  registerTabsCreateTool(server);

  // Worker management (parallel browser operations)
  registerWorkerCreateTool(server);
  registerWorkerListTool(server);
  registerWorkerDeleteTool(server);

  // Orchestration tools (Chrome-Sisyphus workflow management)
  registerOrchestrationTools(server);

  console.error(`[Tools] Registered ${server.getToolNames().length} tools`);
}
