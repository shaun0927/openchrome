/// <reference types="jest" />
/**
 * Unit tests for ChromePool multi-profile features.
 * Tests acquireInstanceForProfile(), releaseProfileInstance(),
 * and launchNewInstance() with profile support.
 */

import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock ChromeLauncher to avoid actually launching Chrome
jest.mock('../../src/chrome/launcher', () => ({
  ChromeLauncher: jest.fn().mockImplementation(() => ({
    ensureChrome: jest.fn().mockResolvedValue({}),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock ProfileManager for validation tests
jest.mock('../../src/chrome/profile-manager', () => ({
  ProfileManager: jest.fn().mockImplementation(() => ({
    listProfiles: jest.fn().mockReturnValue([
      { directory: 'Default', name: 'Person 1', isActive: true },
      { directory: 'Profile 1', name: 'Work', isActive: false },
      { directory: 'Profile 2', name: 'Client', isActive: false },
    ]),
  })),
}));

// Mock the http module to make checkDebugPort return false (port not in use)
jest.mock('http', () => ({
  request: jest.fn((_opts: unknown, _callback: unknown) => {
    // Simulate port not in use by triggering an ECONNREFUSED error
    interface MockReq {
      on: jest.Mock;
      end: jest.Mock;
      destroy: jest.Mock;
    }
    const req: MockReq = {
      on: jest.fn((event: string, handler: (err?: Error) => void) => {
        if (event === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
        return req;
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    return req;
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

import { ChromePool, resetChromePool } from '../../src/chrome/pool';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChromePool — multi-profile features', () => {
  beforeEach(() => {
    // Reset singleton so each test gets a fresh pool
    resetChromePool();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // acquireInstanceForProfile
  // -------------------------------------------------------------------------

  describe('acquireInstanceForProfile()', () => {
    it('reuses an existing instance for the same profileDirectory', async () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19100, autoLaunch: false });

      // First call — launches a new instance
      const first = await pool.acquireInstanceForProfile('Default');
      const firstPort = first.port;
      const firstTabCount = first.tabCount;

      // Second call — should reuse the same instance
      const second = await pool.acquireInstanceForProfile('Default');

      expect(second.port).toBe(firstPort);
      expect(second.tabCount).toBe(firstTabCount + 1);
      expect(pool.getInstances().size).toBe(1);
    });

    it('launches a new instance when no instance matches the profile', async () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19200, autoLaunch: false });

      const inst = await pool.acquireInstanceForProfile('Profile 1');

      expect(inst.profileDirectory).toBe('Profile 1');
      expect(inst.tabCount).toBe(1);
      expect(pool.getInstances().size).toBe(1);
    });

    it('throws when pool is at maxInstances capacity', async () => {
      const pool = new ChromePool({ maxInstances: 2, basePort: 19300, autoLaunch: false });

      // Fill the pool with two different profiles
      await pool.acquireInstanceForProfile('Default');
      await pool.acquireInstanceForProfile('Profile 1');

      // Third profile should fail — pool is at max
      await expect(pool.acquireInstanceForProfile('Profile 2')).rejects.toThrow(
        /Cannot launch Chrome for profile "Profile 2"/
      );
      await expect(pool.acquireInstanceForProfile('Profile 2')).rejects.toThrow(
        /pool is at max capacity/
      );
    });

    it('deduplicates concurrent launches for the same profile (in-flight dedup)', async () => {
      const { ChromeLauncher } = jest.requireMock('../../src/chrome/launcher') as {
        ChromeLauncher: jest.Mock;
      };

      const pool = new ChromePool({ maxInstances: 5, basePort: 19400, autoLaunch: false });

      // Fire two concurrent requests for the same profile
      const [a, b] = await Promise.all([
        pool.acquireInstanceForProfile('Profile 1'),
        pool.acquireInstanceForProfile('Profile 1'),
      ]);

      // Both should resolve to the same port
      expect(a.port).toBe(b.port);
      // Only one Chrome instance should have been launched
      expect(pool.getInstances().size).toBe(1);
      // ChromeLauncher should have been constructed only once for this profile
      const instances = ChromeLauncher.mock.instances;
      expect(instances.length).toBe(1);
    });

    it('throws a descriptive error for an unknown profile directory', async () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19500, autoLaunch: false });

      await expect(
        pool.acquireInstanceForProfile('NonExistent_Profile_XYZ')
      ).rejects.toThrow(/Profile "NonExistent_Profile_XYZ" not found/);

      await expect(
        pool.acquireInstanceForProfile('NonExistent_Profile_XYZ')
      ).rejects.toThrow(/Available profiles:/);

      await expect(
        pool.acquireInstanceForProfile('NonExistent_Profile_XYZ')
      ).rejects.toThrow(/Use list_profiles to see all available profiles/);
    });

    it('lists available profiles in the error message for unknown profile', async () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19600, autoLaunch: false });

      let thrownError: Error | undefined;
      try {
        await pool.acquireInstanceForProfile('NonExistent_Profile_XYZ');
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).toBeDefined();
      // Should list the mocked profiles
      expect(thrownError!.message).toContain('"Default" (Person 1)');
      expect(thrownError!.message).toContain('"Profile 1" (Work)');
      expect(thrownError!.message).toContain('"Profile 2" (Client)');
    });
  });

  // -------------------------------------------------------------------------
  // releaseProfileInstance
  // -------------------------------------------------------------------------

  describe('releaseProfileInstance()', () => {
    it('decrements tabCount and does not go below 0', async () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19700, autoLaunch: false });

      const inst = await pool.acquireInstanceForProfile('Default');
      const portAfterAcquire = inst.port;
      expect(inst.tabCount).toBe(1);

      // Release once — tabCount should go to 0
      pool.releaseProfileInstance(portAfterAcquire);
      const afterFirst = pool.getInstances().get(portAfterAcquire)!;
      expect(afterFirst.tabCount).toBe(0);

      // Release again — should not go negative
      pool.releaseProfileInstance(portAfterAcquire);
      const afterSecond = pool.getInstances().get(portAfterAcquire)!;
      expect(afterSecond.tabCount).toBe(0);
    });

    it('does nothing when port does not exist in pool', () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19800, autoLaunch: false });

      // Should not throw for an unknown port
      expect(() => pool.releaseProfileInstance(99999)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // launchNewInstance — userDataDir isolation and sanitization
  // -------------------------------------------------------------------------

  describe('launchNewInstance() via acquireInstanceForProfile()', () => {
    it('uses an isolated userDataDir under ~/.openchrome/profiles/ for profile instances', async () => {
      const pool = new ChromePool({ maxInstances: 5, basePort: 19900, autoLaunch: false });
      const instance = await pool.acquireInstanceForProfile('Default');

      // Get ensureChrome call args from the launcher stored in the returned instance
      const ensureChrome = instance.launcher.ensureChrome as jest.Mock;
      const callArgs = ensureChrome.mock.calls[0][0];

      const expectedBase = path.join(os.homedir(), '.openchrome', 'profiles');
      expect(callArgs.userDataDir).toBeDefined();
      expect(callArgs.userDataDir).toContain(expectedBase);
    });

    it('sanitizes special characters in profileDirectory to underscores', async () => {
      // Override ProfileManager mock to include a profile with special chars
      const { ProfileManager } = jest.requireMock('../../src/chrome/profile-manager') as {
        ProfileManager: jest.Mock;
      };
      ProfileManager.mockImplementationOnce(() => ({
        listProfiles: jest.fn().mockReturnValue([
          { directory: 'Profile 1', name: 'Work', isActive: false },
          { directory: 'Profile@2!Special', name: 'Special', isActive: false },
        ]),
      }));

      const pool = new ChromePool({ maxInstances: 5, basePort: 19950, autoLaunch: false });
      const instance = await pool.acquireInstanceForProfile('Profile@2!Special');

      const ensureChrome = instance.launcher.ensureChrome as jest.Mock;
      const callArgs = ensureChrome.mock.calls[0][0];

      // Special characters should be replaced with underscores
      expect(callArgs.userDataDir).toBeDefined();
      expect(callArgs.userDataDir).not.toContain('@');
      expect(callArgs.userDataDir).not.toContain('!');
      // The sanitized name part should contain underscores in place of special chars
      expect(callArgs.userDataDir).toContain('Profile_2_Special');
    });
  });
});
