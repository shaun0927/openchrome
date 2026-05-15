/**
 * OpenChrome MCP — navigate to a URL and read the page text.
 * Idiomatic: one `tabs_create` + one `read_page` tool call.
 */
import type { MCPAdapter } from '../../benchmark-runner';

export async function navigateAndRead(adapter: MCPAdapter, url: string): Promise<string> {
  const created = await adapter.callTool('tabs_create', { url });
  const tabId = JSON.parse((created.content[0]?.text as string) ?? '{}').tabId as string;
  const read = await adapter.callTool('read_page', { tabId });
  return (read.content[0]?.text as string) ?? '';
}
