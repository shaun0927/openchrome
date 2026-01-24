/**
 * Tools index - Export all MCP tools
 */

import { SessionManager } from '../session-manager';
import { MCPHandler } from '../mcp-handler';
import { createTabsTools } from './tabs';
import { createNavigateTool } from './navigate';
import { createReadPageTool } from './read-page';
import { createComputerTool } from './computer';
import { createFormInputTool } from './form-input';
import { createFindTool } from './find';
import { createJavaScriptTool } from './javascript';
import { createGetPageTextTool } from './get-page-text';

export { createTabsTools } from './tabs';
export { createNavigateTool } from './navigate';
export { createReadPageTool } from './read-page';
export { createComputerTool } from './computer';
export { createFormInputTool } from './form-input';
export { createFindTool } from './find';
export { createJavaScriptTool } from './javascript';
export { createGetPageTextTool } from './get-page-text';

/**
 * Register all tools with the MCP handler
 */
export function registerAllTools(mcpHandler: MCPHandler, sessionManager: SessionManager): void {
  // Tab tools
  const tabsTools = createTabsTools(sessionManager);
  mcpHandler.registerTool(
    'tabs_context_mcp',
    tabsTools.tabs_context_mcp.handler,
    tabsTools.tabs_context_mcp.definition
  );
  mcpHandler.registerTool(
    'tabs_create_mcp',
    tabsTools.tabs_create_mcp.handler,
    tabsTools.tabs_create_mcp.definition
  );

  // Navigation
  const navigateTool = createNavigateTool(sessionManager);
  mcpHandler.registerTool('navigate', navigateTool.handler, navigateTool.definition);

  // Read page
  const readPageTool = createReadPageTool(sessionManager);
  mcpHandler.registerTool('read_page', readPageTool.handler, readPageTool.definition);

  // Computer (mouse, keyboard, screenshot)
  const computerTool = createComputerTool(sessionManager);
  mcpHandler.registerTool('computer', computerTool.handler, computerTool.definition);

  // Form input
  const formInputTool = createFormInputTool(sessionManager);
  mcpHandler.registerTool('form_input', formInputTool.handler, formInputTool.definition);

  // Find
  const findTool = createFindTool(sessionManager);
  mcpHandler.registerTool('find', findTool.handler, findTool.definition);

  // JavaScript
  const jsTool = createJavaScriptTool(sessionManager);
  mcpHandler.registerTool('javascript_tool', jsTool.handler, jsTool.definition);

  // Get page text
  const getPageTextTool = createGetPageTextTool(sessionManager);
  mcpHandler.registerTool('get_page_text', getPageTextTool.handler, getPageTextTool.definition);
}
