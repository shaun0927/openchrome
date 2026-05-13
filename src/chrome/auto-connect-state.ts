/**
 * Runtime state for `--auto-connect` (#849).
 *
 * Set once at server startup when `--auto-connect` is active; read by
 * `oc_get_connection_info` so MCP clients can introspect the auto-connect
 * mode. Kept in a tiny module so CLI bootstrap and tool handlers don't have
 * to share an import path with `src/index.ts` (which itself depends on the
 * tools module).
 */

import type { AutoConnectResult } from './auto-connect';

export interface AutoConnectState {
  mode: 'auto-connect';
  userDataDir: string;
  port: number;
  wsEndpoint: string;
  browserTargetPath: string;
  /** ms epoch — when the auto-connect handshake completed. */
  attachedAt: number;
}

let current: AutoConnectState | null = null;

export function setAutoConnectState(result: AutoConnectResult): AutoConnectState {
  current = {
    mode: 'auto-connect',
    userDataDir: result.userDataDir,
    port: result.port,
    wsEndpoint: result.wsEndpoint,
    browserTargetPath: result.browserTargetPath,
    attachedAt: Date.now(),
  };
  return current;
}

export function getAutoConnectState(): AutoConnectState | null {
  return current;
}

/** Test-only — clears the singleton so tests can run in isolation. */
export function __resetAutoConnectStateForTests(): void {
  current = null;
}
