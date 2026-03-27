/**
 * Integration tests for stealth mode v2 (#446)
 *
 * Verifies that stealth behavior simulation and fingerprint defenses
 * are properly wired into the navigation and tool pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';

const srcDir = path.join(__dirname, '../../src');

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(srcDir, relPath), 'utf-8');
}

describe('Stealth v2 Integration: navigate.ts', () => {
  const source = readSource('tools/navigate.ts');

  test('imports simulatePresence from stealth module', () => {
    expect(source).toContain("from '../stealth/human-behavior'");
    expect(source).toContain('simulatePresence');
  });

  test('calls simulatePresence only when stealth is true', () => {
    // Find the stealth block
    const stealthBlock = source.slice(
      source.indexOf('if (stealth) {'),
      source.indexOf('AdaptiveScreenshot.getInstance().reset(targetId)')
    );
    expect(stealthBlock).toContain('simulatePresence(page)');
  });

  test('non-stealth path does not call simulatePresence', () => {
    // The simulatePresence call should be guarded by if (stealth)
    const lines = source.split('\n');
    const presenceLine = lines.findIndex(l => l.includes('simulatePresence(page)'));
    expect(presenceLine).toBeGreaterThan(-1);
    // Check the guard exists before it
    const guardLine = lines.slice(Math.max(0, presenceLine - 5), presenceLine)
      .some(l => l.includes('if (stealth)'));
    expect(guardLine).toBe(true);
  });
});

describe('Stealth v2 Integration: session-manager.ts', () => {
  const source = readSource('session-manager.ts');

  test('has stealthTargets Set field', () => {
    expect(source).toContain('stealthTargets');
    expect(source).toContain('new Set<string>()');
  });

  test('adds targetId to stealthTargets in createTargetStealth', () => {
    const methodStart = source.indexOf('async createTargetStealth(');
    const methodBlock = source.slice(methodStart, source.indexOf('\n  /**', methodStart + 100));
    expect(methodBlock).toContain('stealthTargets.add(targetId)');
  });

  test('removes targetId from stealthTargets on close', () => {
    const cleanupBlock = source.slice(source.indexOf('onTargetClosed'));
    expect(cleanupBlock).toContain('stealthTargets.delete(targetId)');
  });

  test('exposes isStealthTarget public method', () => {
    expect(source).toContain('isStealthTarget(targetId: string): boolean');
    expect(source).toContain('stealthTargets.has(targetId)');
  });
});

describe('Stealth v2 Integration: interact.ts', () => {
  const source = readSource('tools/interact.ts');

  test('imports humanMouseMove from stealth module', () => {
    expect(source).toContain("from '../stealth/human-behavior'");
    expect(source).toContain('humanMouseMove');
  });

  test('checks isStealthTarget before using human mouse movement', () => {
    expect(source).toContain('isStealthTarget');
    expect(source).toContain('humanMouseMove(page');
  });
});

describe('Stealth v2 Integration: fill-form.ts', () => {
  const source = readSource('tools/fill-form.ts');

  test('imports humanType and humanMouseMove from stealth module', () => {
    expect(source).toContain("from '../stealth/human-behavior'");
    expect(source).toContain('humanType');
    expect(source).toContain('humanMouseMove');
  });

  test('uses humanType for stealth pages', () => {
    expect(source).toContain('isStealthTarget');
    expect(source).toContain('humanType(page');
  });

  test('uses humanMouseMove before click for stealth pages', () => {
    expect(source).toContain('humanMouseMove(page');
  });
});

describe('Stealth v2 Integration: lightweight-scroll.ts', () => {
  const source = readSource('tools/lightweight-scroll.ts');

  test('imports humanScroll from stealth module', () => {
    expect(source).toContain("from '../stealth/human-behavior'");
    expect(source).toContain('humanScroll');
  });

  test('uses humanScroll for stealth pages', () => {
    expect(source).toContain('isStealthScroll');
    expect(source).toContain('humanScroll(page');
  });
});

describe('Stealth v2 Integration: cdp/client.ts', () => {
  const source = readSource('cdp/client.ts');

  test('imports fingerprint defense scripts', () => {
    expect(source).toContain("from '../stealth/fingerprint-defense'");
    expect(source).toContain('getStealthFingerprintDefenseScript');
    expect(source).toContain('getStealthStackSanitizationScript');
  });

  test('applies fingerprint defenses in createTargetStealth', () => {
    const methodStart = source.indexOf('createTargetStealth(');
    const methodBlock = source.slice(methodStart, source.indexOf('console.error(`[CDPClient] Stealth tab ${targetId} attached'));
    expect(methodBlock).toContain('fpScript');
    expect(methodBlock).toContain('stackScript');
    expect(methodBlock).toContain('evaluateOnNewDocument(fpScript)');
    expect(methodBlock).toContain('page.evaluate(fpScript)');
  });

  test('uses prototype deletion for navigator.webdriver (#446)', () => {
    expect(source).toContain('delete (Object.getPrototypeOf(navigator) as any).webdriver');
  });

  test('fingerprint defenses are stealth-only (not in configurePageDefenses)', () => {
    const configStart = source.indexOf('private configurePageDefenses');
    const configEnd = source.indexOf('\n  /**', configStart + 100);
    const configBlock = source.slice(configStart, configEnd > configStart ? configEnd : configStart + 2000);
    // configurePageDefenses should NOT contain fingerprint defense imports
    expect(configBlock).not.toContain('getStealthFingerprintDefenseScript');
    expect(configBlock).not.toContain('fpScript');
  });
});
