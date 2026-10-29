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

/** Refresh endpoint metadata without changing when the attach mode began. */
export function refreshAutoConnectState(result: AutoConnectResult): AutoConnectState {
  current = {
    mode: 'auto-connect',
    userDataDir: result.userDataDir,
    port: result.port,
    wsEndpoint: result.wsEndpoint,
    browserTargetPath: result.browserTargetPath,
    attachedAt: current?.attachedAt ?? Date.now(),
  };
  return current;
}

export function getAutoConnectState(): AutoConnectState | null {
  return current;
}

/**
 * Browsers attached through `<userDataDir>/DevToolsActivePort` outside the
 * global `--auto-connect` mode (e.g. the user's everyday Chrome serving a
 * profile session). Such browsers may answer 404 on `/json/version`, so the
 * launcher re-reads the file instead of probing HTTP.
 */
const pinnedAttachDirs = new Map<number, string>();

export function pinAttachUserDataDir(port: number, userDataDir: string): void {
  pinnedAttachDirs.set(port, userDataDir);
}

export function getPinnedAttachUserDataDir(port: number): string | undefined {
  return pinnedAttachDirs.get(port);
}

/** Test-only — clears the singleton so tests can run in isolation. */
export function __resetAutoConnectStateForTests(): void {
  current = null;
  pinnedAttachDirs.clear();
}
