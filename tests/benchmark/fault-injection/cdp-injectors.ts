/**
 * CDP-level fault injectors for the Reliability axis (#1259).
 *
 * The HTTP-layer faults live in ./proxy.ts; some failure modes can only be
 * injected through the DevTools Protocol — a tab crash, a forced-offline /
 * throttled network condition, a dropped CDP connection. These builders
 * return plain { method, params } command descriptors so they are
 * unit-testable without a live browser, and applyCdpFault drives a minimal
 * CDP client interface so the same code works against a real connection or a
 * mock. Faults are injected at the protocol layer — no library internals are
 * touched (the #1259 fairness rule).
 */

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
}

/** Minimal CDP client surface the injectors need. */
export interface CdpClientLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Close the underlying CDP connection. */
  close(): Promise<void>;
}

export type CdpFault =
  | { kind: 'tab-crash' }
  | { kind: 'network-offline' }
  | {
      kind: 'network-throttle';
      downloadBytesPerSec: number;
      uploadBytesPerSec: number;
      latencyMs: number;
    }
  | { kind: 'cdp-drop' };

function validateCdpFault(fault: CdpFault): void {
  if (fault.kind === 'network-throttle') {
    if (
      !Number.isFinite(fault.downloadBytesPerSec) ||
      !Number.isFinite(fault.uploadBytesPerSec) ||
      !Number.isFinite(fault.latencyMs) ||
      fault.downloadBytesPerSec < 0 ||
      fault.uploadBytesPerSec < 0 ||
      fault.latencyMs < 0
    ) {
      throw new Error('network-throttle values must be finite and non-negative');
    }
  }
}

/**
 * Build the CDP command sequence that injects a fault. `cdp-drop` has no
 * command sequence — it is enacted by closing the client (see applyCdpFault).
 */
export function buildCdpFaultCommands(fault: CdpFault): CdpCommand[] {
  validateCdpFault(fault);
  switch (fault.kind) {
    case 'tab-crash':
      return [{ method: 'Page.crash' }];
    case 'network-offline':
      return [
        { method: 'Network.enable' },
        {
          method: 'Network.emulateNetworkConditions',
          params: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        },
      ];
    case 'network-throttle':
      return [
        { method: 'Network.enable' },
        {
          method: 'Network.emulateNetworkConditions',
          params: {
            offline: false,
            latency: fault.latencyMs,
            downloadThroughput: fault.downloadBytesPerSec,
            uploadThroughput: fault.uploadBytesPerSec,
          },
        },
      ];
    case 'cdp-drop':
      return [];
  }
}

/**
 * Build the CDP command sequence that clears a fault. Network faults are
 * cleared by restoring unthrottled conditions; a crashed tab or a dropped
 * connection is not "clearable" — it must be recreated by the caller.
 */
export function buildCdpRecoveryCommands(fault: CdpFault): CdpCommand[] {
  switch (fault.kind) {
    case 'network-offline':
    case 'network-throttle':
      return [
        {
          method: 'Network.emulateNetworkConditions',
          params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        },
      ];
    case 'tab-crash':
    case 'cdp-drop':
      return [];
  }
}

export interface ApplyCdpFaultResult {
  fault: CdpFault;
  /** Commands actually sent to the client. */
  commandsSent: CdpCommand[];
  /** True when the fault was enacted by closing the connection (cdp-drop). */
  connectionClosed: boolean;
}

/**
 * Apply a CDP fault against a client.
 *  - cdp-drop:   closes the connection.
 *  - tab-crash:  sends Page.crash; the send may reject as the target dies —
 *                that rejection IS the fault landing, not an error.
 *  - network-*:  sends the emulateNetworkConditions sequence.
 */
export async function applyCdpFault(
  client: CdpClientLike,
  fault: CdpFault,
): Promise<ApplyCdpFaultResult> {
  validateCdpFault(fault);

  if (fault.kind === 'cdp-drop') {
    await client.close();
    return { fault, commandsSent: [], connectionClosed: true };
  }

  const commands = buildCdpFaultCommands(fault);
  const tolerateRejection = fault.kind === 'tab-crash';
  for (const cmd of commands) {
    const sent = client.send(cmd.method, cmd.params);
    if (tolerateRejection) {
      await sent.catch(() => undefined);
    } else {
      await sent;
    }
  }
  return { fault, commandsSent: commands, connectionClosed: false };
}
