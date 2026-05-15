/**
 * OpenChrome MCP — fill a form and submit.
 * Idiomatic: `tabs_create` + `fill_form` + `act` (one step for submit).
 */
import type { MCPAdapter } from '../../benchmark-runner';

export async function formFill(
  adapter: MCPAdapter,
  url: string,
  fields: Record<string, string>,
): Promise<void> {
  await adapter.callTool('tabs_create', { url });
  await adapter.callTool('fill_form', { fields });
  await adapter.callTool('act', { instruction: 'Submit the form' });
}
