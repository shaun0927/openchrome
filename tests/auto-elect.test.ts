/// <reference types="jest" />
/**
 * Unit tests for the auto-elect decision helpers (#1480, D3 Q1′).
 *
 * These lock the election rules that src/index.ts wires into the
 * `serve --auto-launch` path, without booting a server or Chrome.
 */

import {
  isAutoElectEnabled,
  shouldElectBrokerOwner,
  shouldClientAutoConnect,
  defaultBrokerHttpPort,
  BROKER_HTTP_PORT_OFFSET,
} from '../src/broker/auto-elect';

describe('isAutoElectEnabled', () => {
  test('true by default for direct serve --auto-launch path', () => {
    expect(isAutoElectEnabled({ autoLaunch: true }, {})).toBe(true);
  });

  test('false by default when process is not an auto-launch controller', () => {
    expect(isAutoElectEnabled({}, {})).toBe(false);
    expect(isAutoElectEnabled({ autoLaunch: false }, {})).toBe(false);
  });

  test('caller can defer the runtime default by omitting autoLaunch context', () => {
    expect(isAutoElectEnabled({ autoElect: undefined, broker: false, connectBroker: false }, {})).toBe(false);
  });

  test('explicit --auto-elect still enables compatible paths', () => {
    expect(isAutoElectEnabled({ autoElect: true }, {})).toBe(true);
  });

  test('--no-auto-elect hard-disables the default', () => {
    expect(isAutoElectEnabled({ autoLaunch: true, autoElect: false }, {})).toBe(false);
  });

  test('OPENCHROME_AUTO_ELECT=0 hard-disables the default', () => {
    expect(isAutoElectEnabled({ autoLaunch: true }, { OPENCHROME_AUTO_ELECT: '0' })).toBe(false);
    expect(isAutoElectEnabled({ autoLaunch: true, autoElect: true }, { OPENCHROME_AUTO_ELECT: '0' })).toBe(false);
  });

  test('OPENCHROME_AUTO_ELECT=1 explicitly enables compatible paths', () => {
    expect(isAutoElectEnabled({}, { OPENCHROME_AUTO_ELECT: '1' })).toBe(true);
  });

  test('env values other than "0" do not accidentally disable the default', () => {
    expect(isAutoElectEnabled({ autoLaunch: true }, { OPENCHROME_AUTO_ELECT: 'true' })).toBe(true);
    expect(isAutoElectEnabled({ autoLaunch: true }, { OPENCHROME_AUTO_ELECT: '' })).toBe(true);
  });

  test('explicit broker roles take precedence over auto-elect', () => {
    expect(isAutoElectEnabled({ autoLaunch: true, broker: true }, {})).toBe(false);
    expect(isAutoElectEnabled({ autoLaunch: true, connectBroker: true }, {})).toBe(false);
    expect(isAutoElectEnabled({ autoElect: true, broker: true }, {})).toBe(false);
    expect(isAutoElectEnabled({ autoElect: true, connectBroker: true }, {})).toBe(false);
  });
});

describe('shouldElectBrokerOwner', () => {
  const base = { autoElect: true, autoLaunch: true, manualBroker: false, connectBroker: false };

  test('elects when auto-elect + auto-launch and no explicit role', () => {
    expect(shouldElectBrokerOwner(base)).toBe(true);
  });

  test('does not elect when auto-elect is off', () => {
    expect(shouldElectBrokerOwner({ ...base, autoElect: false })).toBe(false);
  });

  test('does not elect without --auto-launch (no Chrome ownership)', () => {
    expect(shouldElectBrokerOwner({ ...base, autoLaunch: false })).toBe(false);
  });

  test('explicit --broker takes precedence over auto-elect', () => {
    expect(shouldElectBrokerOwner({ ...base, manualBroker: true })).toBe(false);
  });

  test('explicit --connect-broker takes precedence over auto-elect', () => {
    expect(shouldElectBrokerOwner({ ...base, connectBroker: true })).toBe(false);
  });
});

describe('shouldClientAutoConnect', () => {
  test('connects only when auto-elect is on and a broker is discoverable', () => {
    expect(shouldClientAutoConnect({ autoElect: true, brokerPresent: true })).toBe(true);
  });

  test('does not connect when no broker is published (plain direct owner)', () => {
    expect(shouldClientAutoConnect({ autoElect: true, brokerPresent: false })).toBe(false);
  });

  test('does not connect when auto-elect is off', () => {
    expect(shouldClientAutoConnect({ autoElect: false, brokerPresent: true })).toBe(false);
  });
});

describe('defaultBrokerHttpPort', () => {
  test('is cdpPort + offset', () => {
    expect(defaultBrokerHttpPort(9222)).toBe(9222 + BROKER_HTTP_PORT_OFFSET);
    expect(defaultBrokerHttpPort(9222)).toBe(9422);
  });

  test('clears the headed-fallback offset (+100)', () => {
    // The fallback uses +100 (9322); the broker must not collide with it.
    expect(defaultBrokerHttpPort(9222)).not.toBe(9222 + 100);
  });
});
