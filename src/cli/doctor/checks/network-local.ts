/**
 * Check: network-local
 * Verifies DNS resolves 127.0.0.1 and the loopback TCP interface accepts connections.
 * Makes zero outbound requests.
 */

import * as net from 'net';
import * as dns from 'dns';
import type { CheckFn } from '../../doctor';

function dnsResolveLocalhost(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dns.lookup('localhost', { all: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve((addresses as Array<{ address: string }>).map(a => a.address));
    });
  });
}

function tcpConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });

    socket.connect(port, host);
  });
}

function openEphemeralServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise(res => server.close(() => res())),
      });
    });
    server.once('error', reject);
  });
}

export const checkNetworkLocal: CheckFn = async () => {
  // 1. DNS resolves localhost
  let addresses: string[] = [];
  try {
    addresses = await dnsResolveLocalhost();
  } catch (err) {
    return {
      id: 'network-local',
      title: 'Local network (loopback)',
      status: 'fail',
      detail: `DNS lookup for localhost failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Check /etc/hosts — localhost should resolve to 127.0.0.1',
    };
  }

  const hasLoopback = addresses.some(a => a === '127.0.0.1' || a === '::1');
  if (!hasLoopback) {
    return {
      id: 'network-local',
      title: 'Local network (loopback)',
      status: 'warn',
      detail: `localhost resolves to ${addresses.join(', ')} but not 127.0.0.1 or ::1`,
      remediation: 'Add "127.0.0.1 localhost" to /etc/hosts',
    };
  }

  // 2. Loopback TCP connect — open an ephemeral server and connect to it
  let ephemeral: { port: number; close: () => Promise<void> } | null = null;
  try {
    ephemeral = await openEphemeralServer();
    const connected = await tcpConnect('127.0.0.1', ephemeral.port);
    if (!connected) {
      return {
        id: 'network-local',
        title: 'Local network (loopback)',
        status: 'fail',
        detail: 'Loopback TCP connect to 127.0.0.1 failed',
        remediation: 'Check firewall rules — loopback TCP must be allowed',
      };
    }
  } catch (err) {
    return {
      id: 'network-local',
      title: 'Local network (loopback)',
      status: 'fail',
      detail: `Loopback TCP test failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Check firewall rules — loopback TCP must be allowed',
    };
  } finally {
    if (ephemeral) await ephemeral.close();
  }

  return {
    id: 'network-local',
    title: 'Local network (loopback)',
    status: 'ok',
    detail: `localhost → ${addresses.join(', ')}; loopback TCP ok`,
  };
};
