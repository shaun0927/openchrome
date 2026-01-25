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

export function registerAllTools(server: MCPServer): void {
  registerNavigateTool(server);
  registerComputerTool(server);
  registerReadPageTool(server);
  registerFindTool(server);
  registerFormInputTool(server);
  registerJavascriptTool(server);
  registerTabsContextTool(server);
  registerTabsCreateTool(server);
  registerNetworkTool(server);

  console.error(`[Tools] Registered ${server.getToolNames().length} tools`);
}
