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
 * The default applies only to the direct `serve --auto-launch` path. Operators
 * can still opt out (`--no-auto-elect` / `OPENCHROME_AUTO_ELECT=0`) or choose an
 * explicit role (`--broker` / `--connect-broker`), and the unsafe shared attach
 * escape hatch remains separate. Keeping the decisions here (rather than inline
 * in src/index.ts) makes the election rules unit-testable without booting a
 * server or Chrome.
 */

/** Offset from the CDP port used for the elected owner's broker HTTP endpoint. */
export const BROKER_HTTP_PORT_OFFSET = 200;

export interface AutoElectDecisionContext {
  /** Commander value for --auto-elect / --no-auto-elect. false is explicit opt-out. */
  autoElect?: boolean;
  /** This process owns Chrome lifecycle and participates in controller-lock election. */
  autoLaunch?: boolean;
  /** Explicit broker owner role. Explicit roles take precedence over auto-elect. */
  broker?: boolean;
  /** Explicit broker client role. Explicit roles take precedence over auto-elect. */
  connectBroker?: boolean;
}

/**
 * Is coordinated auto-elect enabled for this process?
 *
 * Default true only for the direct `serve --auto-launch` path. Explicit opt-outs
 * win (`--no-auto-elect`, `OPENCHROME_AUTO_ELECT=0`), and explicit broker/client
 * roles are not auto-election decisions.
 */
export function isAutoElectEnabled(
  opts: AutoElectDecisionContext,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENCHROME_AUTO_ELECT === '0' || opts.autoElect === false) return false;
  if (opts.broker || opts.connectBroker) return false;
  if (opts.autoElect === true || env.OPENCHROME_AUTO_ELECT === '1') return true;
  return opts.autoLaunch === true;
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
