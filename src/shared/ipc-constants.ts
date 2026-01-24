/**
 * IPC Constants - Paths and configuration for Master-Worker communication
 */

import * as path from 'path';
import * as os from 'os';

// Named pipe/socket names
export const IPC_PIPE_NAME = 'claude-chrome-parallel';

// Windows: Named Pipe
export const WINDOWS_PIPE_PATH = `\\\\.\\pipe\\${IPC_PIPE_NAME}`;

// Unix: Domain Socket
export const UNIX_SOCKET_PATH = path.join(os.tmpdir(), `${IPC_PIPE_NAME}.sock`);

// Get the appropriate IPC path for the current platform
export function getIPCPath(): string {
  return process.platform === 'win32' ? WINDOWS_PIPE_PATH : UNIX_SOCKET_PATH;
}

// Default Chrome debugging port
export const DEFAULT_CHROME_PORT = 9222;

// IPC timeouts
export const IPC_CONNECT_TIMEOUT = 5000;  // 5 seconds
export const IPC_REQUEST_TIMEOUT = 30000; // 30 seconds
export const IPC_HEARTBEAT_INTERVAL = 10000; // 10 seconds

// Master check interval for worker cleanup
export const WORKER_CLEANUP_INTERVAL = 30000; // 30 seconds

// Worker reconnection settings
export const WORKER_RECONNECT_ATTEMPTS = 3;
export const WORKER_RECONNECT_DELAY = 1000; // 1 second

// Auto-start master timeout
export const MASTER_START_TIMEOUT = 10000; // 10 seconds
