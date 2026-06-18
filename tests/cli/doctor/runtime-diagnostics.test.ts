import * as os from 'os';
import { classifyRuntimePath, displayPath } from '../../../src/cli/doctor/runtime-diagnostics';

describe('doctor runtime diagnostics', () => {
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

  test('classifies direct owner, blocked owner, isolated profile, and unknown', () => {
    expect(classifyRuntimePath({ controllerRole: 'owner', ownerPid: 10 })).toBe('direct-owner');
    expect(classifyRuntimePath({ controllerRole: 'unknown', ownerPid: 10 })).toBe('blocked-by-owner');
    expect(classifyRuntimePath({ controllerRole: 'unlocked', launchMode: 'isolated' })).toBe('isolated-profile');
    expect(classifyRuntimePath({ controllerRole: 'unlocked' })).toBe('unknown');
  });

  test('redacts home-relative paths for display facts', () => {
    const home = os.homedir();
    expect(displayPath(`${home}/.openchrome/profile`)).toBe('~/.openchrome/profile');
    expect(displayPath(home)).toBe('~');
    expect(displayPath('/var/tmp/openchrome-profile')).toBe('/var/tmp/openchrome-profile');
  });
});
