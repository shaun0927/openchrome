/**
 * browser-use auth-setup script for the Auth & Real-World Usability axis (#1260).
 *
 * browser-use's idiomatic auth flow runs through its agent: a natural-
 * language instruction directs the agent to fill the form, and the library's
 * planning loop handles selector resolution. For the reproducible tier this
 * script issues the agent prompt via the Python bridge from PR #1280.
 */

import { BrowserUseAdapter } from '../adapters';
import { AUTH_APP_CREDENTIALS } from '../fixtures/auth-app/server';

export async function browserUseAuthSetup(baseUrl: string): Promise<void> {
  const adapter = new BrowserUseAdapter();
  await adapter.setup();
  await adapter.callTool('tabs_create', { url: `${baseUrl}/login` });
  await adapter.callTool('act', {
    instruction:
      `Fill the username field with "${AUTH_APP_CREDENTIALS.username}" and the ` +
      `password field with "${AUTH_APP_CREDENTIALS.password}", then click Submit.`,
  });
  await adapter.teardown();
}
