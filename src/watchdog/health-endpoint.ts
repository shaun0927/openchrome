/**
 * Health Endpoint — optional HTTP health check server.
 * Runs on a separate port from the MCP server for external monitoring.
 * Part of #347 Layer 4: Application Watchdog.
 */

import * as http from 'http';
import { getMetricsCollector } from '../metrics/collector';

export interface HealthData {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  memory: NodeJS.MemoryUsage;
  eventLoop: {
    maxDriftMs: number;
    warnCount: number;
  };
  chrome?: {
    connected: boolean;
    reconnectCount: number;
    reconnecting?: boolean;
    reconnectAttempt?: number;
    nextRetryInMs?: number;
  };
  tabs?: {
    total: number;
    healthy: number;
    unhealthy: number;
  };
  disk?: {
    totalBytes: number;
    fileCount: number;
  };
  browserState?: {
    lastSnapshotAt: number;
    snapshotCount: number;
  };
  chromeProcess?: {
    pid: number;
    rssBytes: number;
  };
  sessions?: {
    active: number;
  };
}

export type HealthDataProvider = () => HealthData;

export class HealthEndpoint {
  private server: http.Server | null = null;
  private readonly port: number;
  private readonly provider: HealthDataProvider;

  // 9090 avoids conflict with Node.js inspector (9229), Chrome DevTools (9222)
  constructor(provider: HealthDataProvider, port = 9090) {
    this.port = port;
    this.provider = provider;
  }

  /**
   * Start the health HTTP server.
   * Binds to 127.0.0.1 only (not exposed externally).
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/health' && req.method === 'GET') {
          try {
            const data = this.provider();
            const statusCode = data.status === 'ok' ? 200 : data.status === 'degraded' ? 200 : 503;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
          } catch (error) {
            console.error('[HealthEndpoint] Provider error:', error);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: 'Internal health check failure' }));
          }
        } else if (req.url === '/metrics' && req.method === 'GET') {
          try {
            // Update dynamic gauges before export
            const data = this.provider();
            const metrics = getMetricsCollector();
            metrics.set('openchrome_heap_bytes', {}, data.memory.heapUsed);
            if (data.tabs) {
              metrics.set('openchrome_tabs_health', { status: 'healthy' }, data.tabs.healthy);
              metrics.set('openchrome_tabs_health', { status: 'unhealthy' }, data.tabs.unhealthy);
            }
            metrics.set('openchrome_active_sessions', {}, data.sessions?.active ?? 0);

            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(metrics.export());
          } catch (error) {
            console.error('[HealthEndpoint] Metrics export error:', error);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('# Error exporting metrics\n');
          }
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[HealthEndpoint] Port ${this.port} already in use, health endpoint disabled`);
          this.server = null;
          resolve(); // Don't fail — health endpoint is optional
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.error(`[HealthEndpoint] Health check: http://127.0.0.1:${this.port}/health`);
        console.error(`[HealthEndpoint] Prometheus metrics: http://127.0.0.1:${this.port}/metrics`);
        resolve();
      });

      // Don't prevent process exit
      this.server.unref();
    });
  }

  /**
   * Stop the health server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Whether the server is running.
   */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}
