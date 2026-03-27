/**
 * Tests for Chrome launcher flag optimization for stealth mode (#453)
 *
 * Verifies that known bot-detection signals are absent from the launcher source,
 * essential flags are present, and stability flags are conditional on profileType.
 *
 * Uses source-level checks (same pattern as launcher-diagnostics.test.ts) since
 * the flags are built from static string literals in launcher.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

const launcherPath = path.join(__dirname, '../../src/chrome/launcher.ts');
let launcherSource: string;

beforeAll(() => {
  launcherSource = fs.readFileSync(launcherPath, 'utf8');
});

describe('Chrome launch flag stealth optimization (#453)', () => {
  describe('bot-detection flags are removed', () => {
    // These checks verify that removed flags do not appear as active string literals
    // (i.e., inside args.push() calls). They may still appear in comments for
    // auditability — so we match only quoted flag strings, not comment text.

    it('should NOT contain --disable-background-networking as an active argument', () => {
      expect(launcherSource).not.toMatch(/'--disable-background-networking'/);
    });

    it('should NOT contain --disable-sync as an active argument', () => {
      expect(launcherSource).not.toMatch(/'--disable-sync'/);
    });

    it('should NOT contain --disable-translate as an active argument', () => {
      expect(launcherSource).not.toMatch(/'--disable-translate'/);
    });

    it('should NOT contain --renderer-process-limit as an active argument', () => {
      expect(launcherSource).not.toMatch(/'--renderer-process-limit/);
    });

    it('should NOT contain --js-flags=--max-old-space-size as an active argument', () => {
      expect(launcherSource).not.toMatch(/'--js-flags=--max-old-space-size/);
    });

    it('should NOT contain --disable-crash-reporter as an active argument', () => {
      expect(launcherSource).not.toMatch(/'--disable-crash-reporter'/);
    });
  });

  describe('essential flags are present', () => {
    it('should contain --no-first-run', () => {
      expect(launcherSource).toContain('--no-first-run');
    });

    it('should contain --no-default-browser-check', () => {
      expect(launcherSource).toContain('--no-default-browser-check');
    });

    it('should contain --start-maximized', () => {
      expect(launcherSource).toContain('--start-maximized');
    });

    it('should contain --window-size', () => {
      expect(launcherSource).toContain('--window-size=');
    });

    it('should contain --disable-blink-features=AutomationControlled (regression guard, #247)', () => {
      expect(launcherSource).toContain('--disable-blink-features=AutomationControlled');
    });

    it('should contain --remote-debugging-port', () => {
      expect(launcherSource).toContain('--remote-debugging-port=');
    });

    it('should contain --user-data-dir', () => {
      expect(launcherSource).toContain('--user-data-dir=');
    });
  });

  describe('stability flags are conditional on profileType', () => {
    it('should gate --disable-backgrounding-occluded-windows behind profileType !== real check', () => {
      const lines = launcherSource.split('\n');
      const flagIdx = lines.findIndex(l => l.includes('--disable-backgrounding-occluded-windows'));
      expect(flagIdx).toBeGreaterThan(-1);

      const precedingCode = lines.slice(0, flagIdx).join('\n');
      const lastProfileCheck = precedingCode.lastIndexOf("profileType !== 'real'");
      expect(lastProfileCheck).toBeGreaterThan(-1);
    });

    it('should gate --disable-gpu-crash-limit behind profileType !== real check', () => {
      const lines = launcherSource.split('\n');
      const flagIdx = lines.findIndex(l => l.includes('--disable-gpu-crash-limit'));
      expect(flagIdx).toBeGreaterThan(-1);

      const precedingCode = lines.slice(0, flagIdx).join('\n');
      const lastProfileCheck = precedingCode.lastIndexOf("profileType !== 'real'");
      expect(lastProfileCheck).toBeGreaterThan(-1);
    });

    it('should gate --disable-session-crashed-bubble behind profileType !== real check', () => {
      const lines = launcherSource.split('\n');
      const flagIdx = lines.findIndex(l => l.includes('--disable-session-crashed-bubble'));
      expect(flagIdx).toBeGreaterThan(-1);

      const precedingCode = lines.slice(0, flagIdx).join('\n');
      const lastProfileCheck = precedingCode.lastIndexOf("profileType !== 'real'");
      expect(lastProfileCheck).toBeGreaterThan(-1);
    });

    it('should gate --hide-crash-restore-bubble behind profileType !== real check', () => {
      const lines = launcherSource.split('\n');
      const flagIdx = lines.findIndex(l => l.includes('--hide-crash-restore-bubble'));
      expect(flagIdx).toBeGreaterThan(-1);

      const precedingCode = lines.slice(0, flagIdx).join('\n');
      const lastProfileCheck = precedingCode.lastIndexOf("profileType !== 'real'");
      expect(lastProfileCheck).toBeGreaterThan(-1);
    });
  });

  describe('removal comment documentation', () => {
    it('should have a comment documenting the removed flags for auditability', () => {
      expect(launcherSource).toContain('--disable-background-networking');
      expect(launcherSource).toContain('--disable-sync');
      expect(launcherSource).toContain('--disable-translate');
      expect(launcherSource).toContain('#453');
    });
  });
});
