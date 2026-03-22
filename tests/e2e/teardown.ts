/**
 * E2E Global Teardown — stops MCP server + fixture HTTP server.
 */
import * as fs from 'fs';
import * as path from 'path';

export default async function globalTeardown(): Promise<void> {
  // Read state
  const stateFile = path.join(process.cwd(), '.e2e-state.json');

  try {
    if (fs.existsSync(stateFile)) {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));

      // Kill MCP server
      if (state.mcpPid) {
        try {
          process.kill(state.mcpPid, 'SIGTERM');
          console.error(`[e2e-teardown] Killed MCP server (pid: ${state.mcpPid})`);
        } catch {
          // Process may have already exited
        }
      }

      fs.unlinkSync(stateFile);
    }
  } catch (err) {
    console.error(`[e2e-teardown] Cleanup error: ${err}`);
  }

  // Close fixture server if still referenced
  const server = (globalThis as Record<string, unknown>).__E2E_FIXTURE_SERVER__ as
    import('http').Server | undefined;
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    console.error('[e2e-teardown] Fixture server stopped');
  }

  console.error('[e2e-teardown] Cleanup complete');
}
