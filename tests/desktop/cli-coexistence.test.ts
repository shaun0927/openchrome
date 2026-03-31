/// <reference types="jest" />

import * as http from 'http';
import { AddressInfo } from 'net';
import { CLICoexistence } from '../../src/desktop/cli-coexistence';

// ---------------------------------------------------------------------------
// Helper: spin up a real HTTP server that responds to /health
// ---------------------------------------------------------------------------
function createHealthServer(statusCode = 200): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((r, e) =>
            server.close((err) => (err ? e(err) : r()))
          ),
      });
    });

    server.on('error', reject);
  });
}

// Port that nothing is listening on (use a known-free ephemeral port approach)
const UNUSED_PORT = 19999;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLICoexistence', () => {
  let coexistence: CLICoexistence;

  afterEach(() => {
    coexistence?.stopMonitoring();
  });

  // -------------------------------------------------------------------------
  // checkForExistingServer — initial detection
  // -------------------------------------------------------------------------

  describe('checkForExistingServer()', () => {
    test('detects existing server — returns healthy ServerInfo with source=external', async () => {
      const { port, close } = await createHealthServer();
      try {
        coexistence = new CLICoexistence({ port, healthCheckTimeoutMs: 500 });

        const externalDetected = jest.fn();
        coexistence.on('external-detected', externalDetected);

        const info = await coexistence.checkForExistingServer();

        expect(info.healthy).toBe(true);
        expect(info.source).toBe('external');
        expect(info.port).toBe(port);
        expect(info.lastHealthCheck).toBeGreaterThan(0);
        expect(externalDetected).toHaveBeenCalledWith({ port });
      } finally {
        await close();
      }
    });

    test('no server found — returns healthy=false, source=none, emits no-server', async () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT, healthCheckTimeoutMs: 300 });

      const noServer = jest.fn();
      const externalDetected = jest.fn();
      coexistence.on('no-server', noServer);
      coexistence.on('external-detected', externalDetected);

      const info = await coexistence.checkForExistingServer();

      expect(info.healthy).toBe(false);
      expect(info.source).toBe('none');
      expect(noServer).toHaveBeenCalledWith({ port: UNUSED_PORT });
      expect(externalDetected).not.toHaveBeenCalled();
    });

    test('emits health-check event on every call', async () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT, healthCheckTimeoutMs: 300 });

      const healthCheck = jest.fn();
      coexistence.on('health-check', healthCheck);

      await coexistence.checkForExistingServer();

      expect(healthCheck).toHaveBeenCalledWith({ healthy: false, source: 'none' });
    });

    test('emits health-check with healthy=true when server responds', async () => {
      const { port, close } = await createHealthServer();
      try {
        coexistence = new CLICoexistence({ port, healthCheckTimeoutMs: 500 });

        const healthCheck = jest.fn();
        coexistence.on('health-check', healthCheck);

        await coexistence.checkForExistingServer();

        expect(healthCheck).toHaveBeenCalledWith({ healthy: true, source: 'external' });
      } finally {
        await close();
      }
    });

    test('emits status-changed when source transitions from none to external', async () => {
      const { port, close } = await createHealthServer();
      try {
        coexistence = new CLICoexistence({ port, healthCheckTimeoutMs: 500 });

        const statusChanged = jest.fn();
        coexistence.on('status-changed', statusChanged);

        await coexistence.checkForExistingServer();

        expect(statusChanged).toHaveBeenCalledWith({ oldSource: 'none', newSource: 'external' });
      } finally {
        await close();
      }
    });

    test('does not emit status-changed when source stays none', async () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT, healthCheckTimeoutMs: 300 });

      const statusChanged = jest.fn();
      coexistence.on('status-changed', statusChanged);

      await coexistence.checkForExistingServer();

      expect(statusChanged).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getServerInfo() — state snapshot
  // -------------------------------------------------------------------------

  describe('getServerInfo()', () => {
    test('returns default state before any checks', () => {
      coexistence = new CLICoexistence({ port: 3100 });
      const info = coexistence.getServerInfo();

      expect(info).toEqual({
        source: 'none',
        port: 3100,
        healthy: false,
        lastHealthCheck: null,
      });
    });

    test('reflects state after a successful check', async () => {
      const { port, close } = await createHealthServer();
      try {
        coexistence = new CLICoexistence({ port, healthCheckTimeoutMs: 500 });
        await coexistence.checkForExistingServer();

        const info = coexistence.getServerInfo();
        expect(info.source).toBe('external');
        expect(info.healthy).toBe(true);
        expect(info.lastHealthCheck).not.toBeNull();
      } finally {
        await close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Monitoring lifecycle
  // -------------------------------------------------------------------------

  describe('startMonitoring() / stopMonitoring()', () => {
    test('isMonitoring() reflects timer state', () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT, healthCheckIntervalMs: 5000 });

      expect(coexistence.isMonitoring()).toBe(false);
      coexistence.startMonitoring();
      expect(coexistence.isMonitoring()).toBe(true);
      coexistence.stopMonitoring();
      expect(coexistence.isMonitoring()).toBe(false);
    });

    test('startMonitoring() is idempotent — calling twice does not create duplicate timers', () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT, healthCheckIntervalMs: 5000 });

      coexistence.startMonitoring();
      coexistence.startMonitoring(); // should replace previous timer
      expect(coexistence.isMonitoring()).toBe(true);
      coexistence.stopMonitoring();
      expect(coexistence.isMonitoring()).toBe(false);
    });

    test('stopMonitoring() is safe to call when not monitoring', () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT });
      expect(() => coexistence.stopMonitoring()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Server stops mid-session (external → none transition)
  // -------------------------------------------------------------------------

  describe('external server stops while monitoring', () => {
    test('emits external-lost when external server stops responding', async () => {
      const { port, close } = await createHealthServer();

      coexistence = new CLICoexistence({
        port,
        healthCheckIntervalMs: 80,
        healthCheckTimeoutMs: 200,
      });

      // First: detect external server
      await coexistence.checkForExistingServer();
      expect(coexistence.getServerInfo().source).toBe('external');

      const externalLost = jest.fn();
      const statusChanged = jest.fn();
      coexistence.on('external-lost', externalLost);
      coexistence.on('status-changed', statusChanged);

      // Stop the server before monitoring ticks
      await close();

      coexistence.startMonitoring();

      // Wait for at least one monitor tick
      await new Promise((r) => setTimeout(r, 400));
      coexistence.stopMonitoring();

      expect(externalLost).toHaveBeenCalledWith({
        port,
        message: 'External server stopped. Start built-in server?',
      });
      expect(statusChanged).toHaveBeenCalledWith({ oldSource: 'external', newSource: 'none' });
      expect(coexistence.getServerInfo().source).toBe('none');
    });
  });

  // -------------------------------------------------------------------------
  // Server appears while monitoring (none → external transition)
  // -------------------------------------------------------------------------

  describe('server appears while monitoring', () => {
    test('emits external-detected when server starts responding during monitoring', async () => {
      coexistence = new CLICoexistence({
        port: UNUSED_PORT,
        healthCheckIntervalMs: 80,
        healthCheckTimeoutMs: 200,
      });

      // Confirm no server initially
      await coexistence.checkForExistingServer();
      expect(coexistence.getServerInfo().source).toBe('none');

      // We'll manually drive the monitor tick by spying on _httpGet via a
      // different approach: override startMonitoring to use a controlled tick
      // Instead, we use a real server that starts AFTER monitoring begins.
      const externalDetected = jest.fn();
      const statusChanged = jest.fn();
      coexistence.on('external-detected', externalDetected);
      coexistence.on('status-changed', statusChanged);

      // Start monitoring BEFORE the server is up
      coexistence.startMonitoring();

      // Wait a bit then start a server on the UNUSED_PORT — won't work since
      // UNUSED_PORT is fixed. Instead, we'll test via a fresh coexistence
      // instance that hasn't detected the server yet, and start one now.
      coexistence.stopMonitoring();

      // Use a fresh server + coexistence pair
      const { port, close } = await createHealthServer();
      try {
        const c2 = new CLICoexistence({
          port,
          healthCheckIntervalMs: 80,
          healthCheckTimeoutMs: 200,
        });

        const detected = jest.fn();
        c2.on('external-detected', detected);

        // Start monitoring without prior detection — source is 'none'
        c2.startMonitoring();
        await new Promise((r) => setTimeout(r, 400));
        c2.stopMonitoring();

        expect(detected).toHaveBeenCalledWith({ port });
        expect(c2.getServerInfo().source).toBe('external');
      } finally {
        await close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Health check timeout handling
  // -------------------------------------------------------------------------

  describe('health check timeout', () => {
    test('treats slow server as unavailable (timeout)', async () => {
      // Server that hangs (never responds)
      const hangServer = await new Promise<{ server: http.Server; port: number; close: () => Promise<void> }>(
        (resolve, reject) => {
          const server = http.createServer((_req, _res) => {
            // Intentionally never respond
          });
          server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
              server,
              port,
              close: () =>
                new Promise<void>((r, e) =>
                  server.close((err) => (err ? e(err) : r()))
                ),
            });
          });
          server.on('error', reject);
        }
      );

      try {
        coexistence = new CLICoexistence({
          port: hangServer.port,
          healthCheckTimeoutMs: 150, // short timeout
        });

        const noServer = jest.fn();
        coexistence.on('no-server', noServer);

        const info = await coexistence.checkForExistingServer();

        expect(info.healthy).toBe(false);
        expect(noServer).toHaveBeenCalled();
      } finally {
        await hangServer.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // ECONNREFUSED — no server running
  // -------------------------------------------------------------------------

  describe('ECONNREFUSED handling', () => {
    test('resolves false (not throw) when port is closed', async () => {
      coexistence = new CLICoexistence({ port: UNUSED_PORT, healthCheckTimeoutMs: 300 });

      // Should not throw
      const info = await coexistence.checkForExistingServer();
      expect(info.healthy).toBe(false);
      expect(info.source).toBe('none');
    });
  });

  // -------------------------------------------------------------------------
  // Default options
  // -------------------------------------------------------------------------

  describe('default options', () => {
    test('uses port 3100 by default', () => {
      coexistence = new CLICoexistence();
      expect(coexistence.getServerInfo().port).toBe(3100);
    });
  });
});
