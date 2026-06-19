import * as os from 'os';

jest.mock('../../../src/utils/duplicate-controller-diagnostics', () => ({
  getCurrentControllerTopology: jest.fn(),
}));
jest.mock('../../../src/broker/discovery', () => ({
  readBrokerMetadata: jest.fn(),
}));
jest.mock('../../../src/utils/controller-lock', () => ({
  isPidAlive: jest.fn(),
}));

const { getCurrentControllerTopology } = jest.requireMock('../../../src/utils/duplicate-controller-diagnostics') as { getCurrentControllerTopology: jest.Mock };
const { readBrokerMetadata } = jest.requireMock('../../../src/broker/discovery') as { readBrokerMetadata: jest.Mock };
const { isPidAlive } = jest.requireMock('../../../src/utils/controller-lock') as { isPidAlive: jest.Mock };
import { classifyRuntimePath, collectDoctorDiagnostics, displayPath } from '../../../src/cli/doctor/runtime-diagnostics';

describe('doctor runtime diagnostics', () => {
  const oldAutoElect = process.env.OPENCHROME_AUTO_ELECT;

  afterEach(() => {
    jest.clearAllMocks();
    if (oldAutoElect === undefined) delete process.env.OPENCHROME_AUTO_ELECT;
    else process.env.OPENCHROME_AUTO_ELECT = oldAutoElect;
  });
  test('classifies unsafe shared attach first', () => {
    expect(classifyRuntimePath({ controllerRole: 'unlocked', unsafeSharedAttachEnabled: true })).toBe('unsafe-secondary-attach');
  });

  test('classifies attach launch mode', () => {
    expect(classifyRuntimePath({ controllerRole: 'unlocked', launchMode: 'attach' })).toBe('attach-mode');
  });

  test('classifies broker owner and client', () => {
    expect(classifyRuntimePath({ controllerRole: 'owner', ownerPid: 10, brokerPid: 10, brokerPidAlive: true })).toBe('broker-owner');
    expect(classifyRuntimePath({ controllerRole: 'unknown', ownerPid: 10, brokerPid: 20, brokerPidAlive: true })).toBe('broker-client');
  });

  test('classifies auto-elect owner and client', () => {
    expect(classifyRuntimePath({ controllerRole: 'owner', ownerPid: 10, brokerPid: 10, brokerPidAlive: true, autoElectEnabled: true })).toBe('auto-elect-owner');
    expect(classifyRuntimePath({ controllerRole: 'unknown', ownerPid: 10, brokerPid: 20, brokerPidAlive: true, autoElectEnabled: true })).toBe('auto-elect-client');
  });

  test('classifies stale broker metadata', () => {
    expect(classifyRuntimePath({ controllerRole: 'owner', ownerPid: 10, brokerPid: 99, brokerPidAlive: false })).toBe('stale-broker-metadata');
  });

  test('classifies direct owner, blocked owner, isolated profile, and unknown', () => {
    expect(classifyRuntimePath({ controllerRole: 'owner', ownerPid: 10 })).toBe('direct-owner');
    expect(classifyRuntimePath({ controllerRole: 'unknown', ownerPid: 10 })).toBe('blocked-by-owner');
    expect(classifyRuntimePath({ controllerRole: 'unlocked', launchMode: 'isolated' })).toBe('isolated-profile');
    expect(classifyRuntimePath({ controllerRole: 'unlocked' })).toBe('unknown');
  });

  test('collects auto-elect topology from owner command metadata', () => {
    delete process.env.OPENCHROME_AUTO_ELECT;
    getCurrentControllerTopology.mockReturnValue({
      role: 'owner',
      port: 9222,
      userDataDir: '/tmp/profile',
      lockPath: '/tmp/lock.json',
      ownerPid: 10,
      ownerCommand: ['openchrome', 'serve', '--auto-launch'],
    });
    readBrokerMetadata.mockReturnValue({ pid: 10, endpoint: 'http://127.0.0.1:9422/mcp' });
    isPidAlive.mockReturnValue(true);

    const diagnostics = collectDoctorDiagnostics();

    expect(diagnostics.runtime.runtime_topology).toBe('auto-elect-owner');
    expect(diagnostics.runtime.facts.autoElectEnabled).toBe(true);
  });

  test('owner command --no-auto-elect overrides default auto-elect diagnostics', () => {
    delete process.env.OPENCHROME_AUTO_ELECT;
    getCurrentControllerTopology.mockReturnValue({
      role: 'owner',
      port: 9222,
      userDataDir: '/tmp/profile',
      lockPath: '/tmp/lock.json',
      ownerPid: 10,
      ownerCommand: ['openchrome', 'serve', '--auto-launch', '--no-auto-elect'],
    });
    readBrokerMetadata.mockReturnValue({ pid: 10, endpoint: 'http://127.0.0.1:9422/mcp' });
    isPidAlive.mockReturnValue(true);

    expect(collectDoctorDiagnostics().runtime.runtime_topology).toBe('broker-owner');
  });

  test('redacts home-relative paths for display facts', () => {
    const home = os.homedir();
    expect(displayPath(`${home}/.openchrome/profile`)).toBe('~/.openchrome/profile');
    expect(displayPath(home)).toBe('~');
    expect(displayPath('/var/tmp/openchrome-profile')).toBe('/var/tmp/openchrome-profile');
  });
});
