import {
  ownerHeartbeatRequiresChrome,
  resolveChromeStartupPolicy,
} from '../../src/chrome/startup-policy';

describe('Chrome startup policy', () => {
  test('normal --auto-launch is lazy', () => {
    expect(resolveChromeStartupPolicy({ autoLaunch: true, eagerStartup: false })).toBe('lazy');
  });

  test('Chrome-ready daemon modes remain eager', () => {
    expect(resolveChromeStartupPolicy({ autoLaunch: true, eagerStartup: true })).toBe('eager');
  });

  test('auto-launch off disables managed startup', () => {
    expect(resolveChromeStartupPolicy({ autoLaunch: false, eagerStartup: false })).toBe('disabled');
    expect(resolveChromeStartupPolicy({ autoLaunch: false, eagerStartup: true })).toBe('disabled');
  });

  test('lazy owners refresh lock heartbeat without Chrome until browser demand starts', () => {
    expect(ownerHeartbeatRequiresChrome('lazy', false)).toBe(false);
    expect(ownerHeartbeatRequiresChrome('lazy', true)).toBe(true);
  });

  test('eager owners always require Chrome health', () => {
    expect(ownerHeartbeatRequiresChrome('eager', false)).toBe(true);
    expect(ownerHeartbeatRequiresChrome('eager', true)).toBe(true);
  });
});
