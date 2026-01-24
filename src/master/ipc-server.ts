/**
 * IPC Server - Named Pipe / Unix Socket server for Master process
 */

import * as net from 'net';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { IPCRequest, IPCResponse } from '../shared/ipc-protocol';
import { getIPCPath, UNIX_SOCKET_PATH } from '../shared/ipc-constants';

interface WorkerConnection {
  id: string;
  socket: net.Socket;
  buffer: string;
  lastHeartbeat: number;
}

export class IPCServer extends EventEmitter {
  private server: net.Server | null = null;
  private workers: Map<string, WorkerConnection> = new Map();
  private ipcPath: string;
  private workerCounter = 0;

  constructor() {
    super();
    this.ipcPath = getIPCPath();
  }

  async listen(): Promise<void> {
    // Clean up existing socket file on Unix
    if (process.platform !== 'win32' && fs.existsSync(UNIX_SOCKET_PATH)) {
      fs.unlinkSync(UNIX_SOCKET_PATH);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        console.error('[IPCServer] Server error:', error);
        reject(error);
      });

      this.server.listen(this.ipcPath, () => {
        console.error(`[IPCServer] Listening on ${this.ipcPath}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    const workerId = `worker-${++this.workerCounter}`;
    const connection: WorkerConnection = {
      id: workerId,
      socket,
      buffer: '',
      lastHeartbeat: Date.now(),
    };

    this.workers.set(workerId, connection);
    console.error(`[IPCServer] Worker connected: ${workerId}`);

    // Send worker ID to the worker
    this.sendToWorker(workerId, {
      id: 'init',
      result: { workerId },
    });

    socket.on('data', (data) => {
      this.handleData(workerId, data);
    });

    socket.on('close', () => {
      console.error(`[IPCServer] Worker disconnected: ${workerId}`);
      this.workers.delete(workerId);
      this.emit('disconnect', workerId);
    });

    socket.on('error', (error) => {
      console.error(`[IPCServer] Socket error for worker ${workerId}:`, error);
    });

    this.emit('connection', workerId);
  }

  private handleData(workerId: string, data: Buffer): void {
    const connection = this.workers.get(workerId);
    if (!connection) return;

    connection.buffer += data.toString();

    // Process complete messages (newline-delimited JSON)
    let newlineIndex: number;
    while ((newlineIndex = connection.buffer.indexOf('\n')) !== -1) {
      const messageStr = connection.buffer.slice(0, newlineIndex);
      connection.buffer = connection.buffer.slice(newlineIndex + 1);

      if (messageStr.trim()) {
        try {
          const request = JSON.parse(messageStr) as IPCRequest;
          request.workerId = workerId;
          connection.lastHeartbeat = Date.now();
          this.emit('request', request);
        } catch (error) {
          console.error('[IPCServer] Failed to parse message:', error);
        }
      }
    }
  }

  sendToWorker(workerId: string, response: IPCResponse): void {
    const connection = this.workers.get(workerId);
    if (!connection) {
      console.error(`[IPCServer] Worker not found: ${workerId}`);
      return;
    }

    try {
      const message = JSON.stringify(response) + '\n';
      connection.socket.write(message);
    } catch (error) {
      console.error(`[IPCServer] Failed to send to worker ${workerId}:`, error);
    }
  }

  broadcast(response: IPCResponse): void {
    for (const workerId of this.workers.keys()) {
      this.sendToWorker(workerId, response);
    }
  }

  getWorkerIds(): string[] {
    return Array.from(this.workers.keys());
  }

  isWorkerConnected(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  async close(): Promise<void> {
    // Close all worker connections
    for (const connection of this.workers.values()) {
      connection.socket.destroy();
    }
    this.workers.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;

          // Clean up socket file on Unix
          if (process.platform !== 'win32' && fs.existsSync(UNIX_SOCKET_PATH)) {
            try {
              fs.unlinkSync(UNIX_SOCKET_PATH);
            } catch {
              // Ignore
            }
          }

          resolve();
        });
      });
    }
  }
}
