/**
 * Tests for Chrome launcher diagnostic improvements (Issue #200)
 */

import { DEFAULT_CHROME_LAUNCH_TIMEOUT_MS, DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS } from '../../src/config/defaults';

describe('Chrome Launch Diagnostics', () => {
  describe('DEFAULT_CHROME_LAUNCH_TIMEOUT_MS constant', () => {
    it('should be defined and be 60000ms', () => {
      expect(DEFAULT_CHROME_LAUNCH_TIMEOUT_MS).toBeDefined();
      expect(DEFAULT_CHROME_LAUNCH_TIMEOUT_MS).toBe(60000);
    });

    it('should be a number', () => {
      expect(typeof DEFAULT_CHROME_LAUNCH_TIMEOUT_MS).toBe('number');
    });
  });

  describe('Session init timeout alignment', () => {
    it('should be longer than Chrome launch timeout', () => {
      expect(DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS).toBeGreaterThan(DEFAULT_CHROME_LAUNCH_TIMEOUT_MS);
    });

    it('should be at least 75000ms to allow Chrome launch + connect', () => {
      expect(DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS).toBeGreaterThanOrEqual(75000);
    });

    it('should give at least 15s margin over Chrome launch timeout', () => {
      const margin = DEFAULT_SESSION_INIT_TIMEOUT_AUTO_LAUNCH_MS - DEFAULT_CHROME_LAUNCH_TIMEOUT_MS;
      expect(margin).toBeGreaterThanOrEqual(15000);
    });
  });

  describe('ChromeLauncher stderr capture', () => {
    it('should spawn Chrome with pipe for stderr', async () => {
      // Verify the spawn configuration by reading the source
      const fs = await import('fs');
      const path = await import('path');
      const launcherSource = fs.readFileSync(
        path.join(__dirname, '../../src/chrome/launcher.ts'),
        'utf8'
      );

      // Should use 'pipe' for stderr (3rd element), not 'ignore'
      expect(launcherSource).toContain("'pipe'");
      // Should NOT have all three as 'ignore'
      expect(launcherSource).not.toMatch(/stdio:\s*\['ignore',\s*'ignore',\s*'ignore'\]/);
    });

    it('should collect stderr chunks', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const launcherSource = fs.readFileSync(
        path.join(__dirname, '../../src/chrome/launcher.ts'),
        'utf8'
      );

      // Should have stderr collection logic
      expect(launcherSource).toContain('stderrChunks');
      expect(launcherSource).toContain('stderr');
    });
  });

  describe('Error message diagnostics', () => {
    it('should include OS info in error messages', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const launcherSource = fs.readFileSync(
        path.join(__dirname, '../../src/chrome/launcher.ts'),
        'utf8'
      );

      // Error messages should include OS diagnostics
      expect(launcherSource).toContain('os.platform()');
      expect(launcherSource).toContain('os.arch()');
    });

    it('should include common causes in error messages', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const launcherSource = fs.readFileSync(
        path.join(__dirname, '../../src/chrome/launcher.ts'),
        'utf8'
      );

      expect(launcherSource).toContain('Common causes');
      expect(launcherSource).toContain('profile lock');
    });

    it('should use DEFAULT_CHROME_LAUNCH_TIMEOUT_MS instead of hardcoded 60000', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const launcherSource = fs.readFileSync(
        path.join(__dirname, '../../src/chrome/launcher.ts'),
        'utf8'
      );

      // Should import and use the constant
      expect(launcherSource).toContain('DEFAULT_CHROME_LAUNCH_TIMEOUT_MS');
      // Should NOT have hardcoded '60000' in the launch timeout parsing
      // (env var fallback should use String(DEFAULT_CHROME_LAUNCH_TIMEOUT_MS))
      const launchTimeoutLines = launcherSource.split('\n').filter(
        line => line.includes('CHROME_LAUNCH_TIMEOUT_MS') && line.includes("||")
      );
      for (const line of launchTimeoutLines) {
        expect(line).not.toContain("'60000'");
      }
    });
  });

  describe('waitForDebugPort error message', () => {
    it('should include helpful context in timeout error', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const launcherSource = fs.readFileSync(
        path.join(__dirname, '../../src/chrome/launcher.ts'),
        'utf8'
      );

      // The waitForDebugPort timeout error should mention possible causes
      const throwLines = launcherSource.split('\n').filter(
        line => line.includes('throw new Error') && line.includes('not available after')
      );
      expect(throwLines.length).toBeGreaterThan(0);
    });
  });
});
