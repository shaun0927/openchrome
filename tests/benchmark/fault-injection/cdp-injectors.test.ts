/// <reference types="jest" />

import {
  buildCdpFaultCommands,
  buildCdpRecoveryCommands,
  applyCdpFault,
  CdpClientLike,
  CdpFault,
} from './cdp-injectors';

function makeMockClient(): {
  client: CdpClientLike;
  sent: Array<{ method: string; params?: Record<string, unknown> }>;
  closed: () => boolean;
} {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let isClosed = false;
  return {
    sent,
    closed: () => isClosed,
    client: {
      async send(method, params) {
        sent.push({ method, params });
        return {};
      },
      async close() {
        isClosed = true;
      },
    },
  };
}

describe('buildCdpFaultCommands', () => {
  test('tab-crash maps to Page.crash', () => {
    expect(buildCdpFaultCommands({ kind: 'tab-crash' })).toEqual([{ method: 'Page.crash' }]);
  });

  test('network-offline enables Network and emulates offline conditions', () => {
    const cmds = buildCdpFaultCommands({ kind: 'network-offline' });
    expect(cmds[0]).toEqual({ method: 'Network.enable' });
    expect(cmds[1].method).toBe('Network.emulateNetworkConditions');
    expect(cmds[1].params).toMatchObject({ offline: true });
  });

  test('network-throttle passes through the throughput + latency values', () => {
    const cmds = buildCdpFaultCommands({
      kind: 'network-throttle',
      downloadBytesPerSec: 50_000,
      uploadBytesPerSec: 20_000,
      latencyMs: 150,
    });
    expect(cmds[1].params).toMatchObject({
      offline: false,
      latency: 150,
      downloadThroughput: 50_000,
      uploadThroughput: 20_000,
    });
  });

  test('cdp-drop has no command sequence', () => {
    expect(buildCdpFaultCommands({ kind: 'cdp-drop' })).toEqual([]);
  });

  test('rejects negative network-throttle values', () => {
    const bad: CdpFault = {
      kind: 'network-throttle',
      downloadBytesPerSec: -1,
      uploadBytesPerSec: 0,
      latencyMs: 0,
    };
    expect(() => buildCdpFaultCommands(bad)).toThrow(/non-negative/);
  });
});

describe('buildCdpRecoveryCommands', () => {
  test('network faults are cleared by restoring unthrottled conditions', () => {
    for (const fault of [
      { kind: 'network-offline' } as const,
      {
        kind: 'network-throttle',
        downloadBytesPerSec: 1,
        uploadBytesPerSec: 1,
        latencyMs: 1,
      } as const,
    ]) {
      const recovery = buildCdpRecoveryCommands(fault);
      expect(recovery).toHaveLength(1);
      expect(recovery[0].params).toMatchObject({ offline: false });
    }
  });

  test('tab-crash and cdp-drop are not clearable — caller must recreate', () => {
    expect(buildCdpRecoveryCommands({ kind: 'tab-crash' })).toEqual([]);
    expect(buildCdpRecoveryCommands({ kind: 'cdp-drop' })).toEqual([]);
  });
});

describe('applyCdpFault', () => {
  test('network-offline sends the full command sequence', async () => {
    const { client, sent } = makeMockClient();
    const result = await applyCdpFault(client, { kind: 'network-offline' });
    expect(sent.map((s) => s.method)).toEqual(['Network.enable', 'Network.emulateNetworkConditions']);
    expect(result.connectionClosed).toBe(false);
    expect(result.commandsSent).toHaveLength(2);
  });

  test('cdp-drop closes the connection and sends nothing', async () => {
    const { client, sent, closed } = makeMockClient();
    const result = await applyCdpFault(client, { kind: 'cdp-drop' });
    expect(closed()).toBe(true);
    expect(sent).toHaveLength(0);
    expect(result.connectionClosed).toBe(true);
  });

  test('tab-crash tolerates the send rejecting as the target dies', async () => {
    const sent: string[] = [];
    const client: CdpClientLike = {
      async send(method) {
        sent.push(method);
        throw new Error('target closed'); // Page.crash kills the connection
      },
      async close() {
        /* noop */
      },
    };
    const result = await applyCdpFault(client, { kind: 'tab-crash' });
    expect(sent).toEqual(['Page.crash']);
    expect(result.connectionClosed).toBe(false);
  });

  test('a rejecting send for a non-crash fault propagates', async () => {
    const client: CdpClientLike = {
      async send() {
        throw new Error('protocol error');
      },
      async close() {
        /* noop */
      },
    };
    await expect(applyCdpFault(client, { kind: 'network-offline' })).rejects.toThrow(
      /protocol error/,
    );
  });
});
