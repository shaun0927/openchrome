/**
 * OpenChrome auth-setup script for the Auth & Real-World Usability axis (#1260).
 *
 * "Idiomatic best-practice": OpenChrome reuses the operator's real Chrome
 * profile via `list_profiles` + profile attach, so a logged-in session
 * inherited from interactive use carries over to the benchmark with ZERO
 * setup code. For the reproducible tier (local login-wall app), OpenChrome
 * drives the form via the same MCP tool surface every other axis uses.
 *
 * LOC counted per the project rule (imports + statements; comments + blank
 * excluded). Idiomatic, not hand-optimized.
 */

import type { MCPAdapter } from '../benchmark-runner';
import { AUTH_APP_CREDENTIALS } from '../fixtures/auth-app/server';

export async function openchromeAuthSetup(adapter: MCPAdapter, baseUrl: string): Promise<void> {
  await adapter.callTool('tabs_create', { url: `${baseUrl}/login` });
  await adapter.callTool('fill_form', {
    fields: {
      username: AUTH_APP_CREDENTIALS.username,
      password: AUTH_APP_CREDENTIALS.password,
    },
  });
  await adapter.callTool('act', { instruction: 'Submit the login form' });
}
