/**
 * Auto-elect coordinated sharing (#1480; SSOT decision D3 Q1′).
 *
 * Pure, side-effect-free decision helpers for the default `serve --auto-launch`
 * election path:
 *
 *   - the process that WINS the controller lock becomes the broker OWNER and
 *     publishes broker discovery metadata (so surplus sessions can attach);
 *   - a process that LOSES to a healthy owner becomes a coordinated CLIENT
 *     (`--connect-broker` proxy) instead of failing fast.
 *
 * The behavior is gated behind an explicit opt-in (`--auto-elect` /
 * `OPENCHROME_AUTO_ELECT=1`). With the flag unset, the default path is byte-for-
 * byte unchanged (fail-fast single owner), so this module's wiring has zero blast
 * radius until an operator opts in. See docs/roadmap/ssot-decisions.md (D3 Q1′)
 * for the policy and the eventual default-flip plan.
 *
 * Keeping the decisions here (rather than inline in src/index.ts) makes the
 * election rules unit-testable without booting a server or Chrome.
 */

/** Offset from the CDP port used for the elected owner's broker HTTP endpoint. */
export const BROKER_HTTP_PORT_OFFSET = 200;

/**
 * Is auto-elect enabled for this process?
 *
 * True when the operator passed `--auto-elect` or set `OPENCHROME_AUTO_ELECT=1`.
 */
export function isAutoElectEnabled(
  opts: { autoElect?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(opts.autoElect) || env.OPENCHROME_AUTO_ELECT === '1';
}

/**
 * Should the lock WINNER elect itself as the broker owner (publish a broker so
 * losers can attach)?
 *
 * Only when auto-elect is on, this process owns Chrome lifecycle (`--auto-launch`),
 * and the operator did not already pick an explicit role. Explicit `--broker` /
 * `--connect-broker` always win over auto-elect — auto-elect never overrides a
 * deliberate operator choice.
 */
export function shouldElectBrokerOwner(params: {
  autoElect: boolean;
  autoLaunch: boolean;
  manualBroker: boolean;
  connectBroker: boolean;
}): boolean {
  return (
    params.autoElect &&
    params.autoLaunch &&
    !params.manualBroker &&
    !params.connectBroker
  );
}

/**
 * Should a process that LOST the controller lock attach as a coordinated client
 * rather than fail fast?
 *
 * Only when auto-elect is on AND a broker is actually discoverable for this
 * `(port, userDataDir)` — i.e. the healthy owner is itself an auto-elect/broker
 * owner. If the owner is a plain direct controller (no broker published), there
 * is nothing to attach to and the caller must fall back to the normal
 * duplicate-controller remediation.
 */
export function shouldClientAutoConnect(params: {
  autoElect: boolean;
  brokerPresent: boolean;
}): boolean {
  return params.autoElect && params.brokerPresent;
}

/**
 * The default broker HTTP port for an auto-elected owner on a given CDP port.
 *
 * Deterministic (`cdpPort + 200`, e.g. 9222 → 9422) so it is predictable and
 * clear of the headed-fallback offset (`+100`). Operators can still override via
 * `--http`/`OPENCHROME_HTTP_PORT`; clients never rely on this value directly —
 * they read the actual endpoint from the published broker metadata.
 */
export function defaultBrokerHttpPort(cdpPort: number): number {
  return cdpPort + BROKER_HTTP_PORT_OFFSET;
}
