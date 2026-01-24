/**
 * IPC Client - Connects Worker to Master via Named Pipe / Unix Socket
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import { IPCRequest, IPCResponse, IPCMethod } from '../shared/ipc-protocol';
import {
  getIPCPath,
  IPC_CONNECT_TIMEOUT,
  IPC_REQUEST_TIMEOUT,
  WORKER_RECONNECT_ATTEMPTS,
  WORKER_RECONNECT_DELAY,
} from '../shared/ipc-constants';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class IPCClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private workerId: string | null = null;
  private buffer = '';
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private connected = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private requestCounter = 0;
  private ipcPath: string;

  constructor() {
    super();
    this.ipcPath = getIPCPath();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
        }
        reject(new Error('Connection timeout'));
      }, IPC_CONNECT_TIMEOUT);

      this.socket = net.createConnection(this.ipcPath, () => {
        console.error(`[IPCClient] Connected to Master at ${this.ipcPath}`);
      });

      // Wait for worker ID from Master
      const initHandler = (data: Buffer) => {
        this.buffer += data.toString();

        const newlineIndex = this.buffer.indexOf('\n');
        if (newlineIndex !== -1) {
          const messageStr = this.buffer.slice(0, newlineIndex);
          this.buffer = this.buffer.slice(newlineIndex + 1);

          try {
            const message = JSON.parse(messageStr) as IPCResponse;
            if (message.id === 'init' && message.result) {
              const result = message.result as { workerId: string };
              this.workerId = result.workerId;
              this.connected = true;
              this.reconnectAttempts = 0;

              clearTimeout(timeout);
              console.error(`[IPCClient] Registered as worker: ${this.workerId}`);

              // Switch to normal data handler
              this.socket!.off('data', initHandler);
              this.socket!.on('data', (d) => this.handleData(d));

              resolve();
            }
          } catch (error) {
            // Not the init message yet
          }
        }
      };

      this.socket.on('data', initHandler);

      this.socket.on('close', () => {
        console.error('[IPCClient] Connection closed');
        this.connected = false;
        this.emit('disconnect');

        if (!this.reconnecting) {
          this.attemptReconnect();
        }
      });

      this.socket.on('error', (error) => {
        console.error('[IPCClient] Socket error:', error);
        if (!this.connected) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const messageStr = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (messageStr.trim()) {
        try {
          const response = JSON.parse(messageStr) as IPCResponse;
          this.handleResponse(response);
        } catch (error) {
          console.error('[IPCClient] Failed to parse message:', error);
        }
      }
    }
  }

  private handleResponse(response: IPCResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.error(`[IPCClient] No pending request for ID: ${response.id}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  async call<T>(method: IPCMethod, params: Record<string, unknown>): Promise<T> {
    if (!this.connected || !this.socket || !this.workerId) {
      throw new Error('Not connected to Master');
    }

    const id = `req-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method}`));
      }, IPC_REQUEST_TIMEOUT);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      const request: IPCRequest = {
        id,
        method,
        params,
        workerId: this.workerId!,
      };

      const message = JSON.stringify(request) + '\n';
      this.socket!.write(message);
    });
  }

  private async attemptReconnect(): Promise<void> {
    this.reconnecting = true;

    while (this.reconnectAttempts < WORKER_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      console.error(`[IPCClient] Reconnection attempt ${this.reconnectAttempts}/${WORKER_RECONNECT_ATTEMPTS}`);

      try {
        await new Promise(resolve => setTimeout(resolve, WORKER_RECONNECT_DELAY));
        await this.connect();
        this.reconnecting = false;
        this.emit('reconnect');
        return;
      } catch (error) {
        console.error('[IPCClient] Reconnection failed:', error);
      }
    }

    this.reconnecting = false;
    console.error('[IPCClient] All reconnection attempts failed');
    this.emit('reconnect_failed');
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.workerId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getWorkerId(): string | null {
    return this.workerId;
  }
}
