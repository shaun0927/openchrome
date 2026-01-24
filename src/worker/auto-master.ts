/**
 * Auto Master - Automatically starts Master process if not running
 */

import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { getIPCPath, MASTER_START_TIMEOUT } from '../shared/ipc-constants';

let masterProcess: ChildProcess | null = null;

/**
 * Check if Master is running by attempting to connect
 */
export async function isMasterRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(getIPCPath());

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Start Master process in background
 */
export async function startMasterProcess(): Promise<void> {
  console.error('[AutoMaster] Starting Master process...');

  // Path to the compiled master module - use the main entry with --master flag
  const entryPath = path.join(__dirname, '..', 'index.js');

  masterProcess = spawn(process.execPath, [entryPath, 'serve', '--master'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  // Don't keep parent process alive
  masterProcess.unref();

  // Log master output for debugging
  masterProcess.stdout?.on('data', (data) => {
    console.error(`[Master stdout] ${data.toString().trim()}`);
  });

  masterProcess.stderr?.on('data', (data) => {
    console.error(`[Master stderr] ${data.toString().trim()}`);
  });

  masterProcess.on('error', (error) => {
    console.error('[AutoMaster] Failed to start Master:', error);
  });

  masterProcess.on('exit', (code) => {
    console.error(`[AutoMaster] Master exited with code ${code}`);
    masterProcess = null;
  });

  // Wait for Master to be ready
  await waitForMaster();
}

/**
 * Wait for Master to become available
 */
export async function waitForMaster(timeout: number = MASTER_START_TIMEOUT): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await isMasterRunning()) {
      console.error('[AutoMaster] Master is ready');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`Master did not start within ${timeout}ms`);
}

/**
 * Ensure Master is running, start if not
 */
export async function ensureMaster(): Promise<void> {
  if (await isMasterRunning()) {
    console.error('[AutoMaster] Master already running');
    return;
  }

  await startMasterProcess();
}

/**
 * Stop the Master process if we started it
 */
export function stopMasterProcess(): void {
  if (masterProcess) {
    masterProcess.kill();
    masterProcess = null;
  }
}
