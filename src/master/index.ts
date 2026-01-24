/**
 * Master Process - Central manager for Chrome connections and sessions
 */

import { SessionRegistry } from './session-registry';
import { IPCServer } from './ipc-server';
import { RequestHandler } from './request-handler';
import { DEFAULT_CHROME_PORT } from '../shared/ipc-constants';

export interface MasterOptions {
  port?: number;
}

export class Master {
  private registry: SessionRegistry | null = null;
  private ipcServer: IPCServer | null = null;
  private requestHandler: RequestHandler | null = null;
  private running = false;

  async start(options: MasterOptions = {}): Promise<void> {
    const port = options.port ?? DEFAULT_CHROME_PORT;

    console.error('[Master] Starting...');
    console.error(`[Master] Chrome port: ${port}`);

    try {
      // Create session registry (will connect to Chrome)
      this.registry = new SessionRegistry();
      await this.registry.ensureConnected();

      // Start IPC server
      this.ipcServer = new IPCServer();
      await this.ipcServer.listen();

      // Set up request handler
      this.requestHandler = new RequestHandler(this.registry, this.ipcServer);

      this.running = true;
      console.error('[Master] Ready for workers');

      // Handle shutdown signals
      process.on('SIGINT', () => this.stop());
      process.on('SIGTERM', () => this.stop());

    } catch (error) {
      console.error('[Master] Startup failed:', error);
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.error('[Master] Shutting down...');
    this.running = false;

    if (this.ipcServer) {
      await this.ipcServer.close();
      this.ipcServer = null;
    }

    this.registry = null;
    this.requestHandler = null;

    console.error('[Master] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStats(): object {
    return {
      running: this.running,
      workers: this.ipcServer?.getWorkerIds().length ?? 0,
      ...this.registry?.getStats(),
    };
  }
}

// Entry point function
export async function startMaster(port: number = DEFAULT_CHROME_PORT): Promise<void> {
  const master = new Master();
  await master.start({ port });

  // Keep process alive and log stats periodically
  setInterval(() => {
    const stats = master.getStats();
    console.error(`[Master] Stats: ${JSON.stringify(stats)}`);
  }, 60000);
}
