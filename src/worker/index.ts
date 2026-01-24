/**
 * Worker Process - MCP server that connects to Master for Chrome operations
 */

import { IPCClient } from './ipc-client';
import { RemoteSessionManager } from './remote-session-manager';
import { ensureMaster } from './auto-master';

export interface WorkerOptions {
  autoStartMaster?: boolean;
}

export class Worker {
  private ipcClient: IPCClient | null = null;
  private sessionManager: RemoteSessionManager | null = null;
  private running = false;

  async start(options: WorkerOptions = {}): Promise<{ sessionManager: RemoteSessionManager }> {
    console.error('[Worker] Starting...');

    try {
      // Ensure Master is running
      if (options.autoStartMaster !== false) {
        await ensureMaster();
      }

      // Connect to Master
      this.ipcClient = new IPCClient();
      await this.ipcClient.connect();

      // Set up reconnection handling
      this.ipcClient.on('disconnect', () => {
        console.error('[Worker] Disconnected from Master');
      });

      this.ipcClient.on('reconnect', () => {
        console.error('[Worker] Reconnected to Master');
      });

      this.ipcClient.on('reconnect_failed', () => {
        console.error('[Worker] Failed to reconnect to Master');
        this.stop();
      });

      // Create remote session manager
      this.sessionManager = new RemoteSessionManager(this.ipcClient);

      this.running = true;
      console.error('[Worker] Connected to Master');

      return { sessionManager: this.sessionManager };

    } catch (error) {
      console.error('[Worker] Startup failed:', error);
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.error('[Worker] Shutting down...');
    this.running = false;

    if (this.ipcClient) {
      await this.ipcClient.disconnect();
      this.ipcClient = null;
    }

    this.sessionManager = null;
    console.error('[Worker] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessionManager(): RemoteSessionManager | null {
    return this.sessionManager;
  }

  getIPCClient(): IPCClient | null {
    return this.ipcClient;
  }
}

// Singleton instance for use by tools
let workerInstance: Worker | null = null;
let remoteSessionManager: RemoteSessionManager | null = null;

export function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker();
  }
  return workerInstance;
}

export function getRemoteSessionManager(): RemoteSessionManager | null {
  return remoteSessionManager;
}

export function setRemoteSessionManager(manager: RemoteSessionManager): void {
  remoteSessionManager = manager;
}

export async function startWorker(): Promise<RemoteSessionManager> {
  const worker = getWorker();
  const { sessionManager } = await worker.start();
  setRemoteSessionManager(sessionManager);
  return sessionManager;
}
