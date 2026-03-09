/// <reference types="jest" />
/**
 * Tests for stealth defenses against anti-bot detection (#257).
 *
 * Verifies:
 * 1. Known automation-signal Chrome flags are absent from launcher args
 * 2. configurePageDefenses has correct evaluateOnNewDocument calls in source
 * 3. --disable-blink-features=AutomationControlled is present for non-headless-shell
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Launcher flag tests (source-level) ──────────────────────────────────────

describe('Stealth: removed automation-signal Chrome flags', () => {
  let launcherSource: string;

  beforeAll(() => {
    const launcherPath = path.join(__dirname, '../../src/chrome/launcher.ts');
    launcherSource = fs.readFileSync(launcherPath, 'utf8');
  });

  test('--metrics-recording-only is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--metrics-recording-only');
  });

  test('--disable-extensions is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-extensions');
  });

  test('--disable-component-extensions-with-background-pages is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-component-extensions-with-background-pages');
  });

  test('--disable-default-apps is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-default-apps');
  });

  test('--disable-ipc-flooding-protection is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-ipc-flooding-protection');
  });

  test('--disable-blink-features=AutomationControlled IS present in launcher source', () => {
    expect(launcherSource).toContain('--disable-blink-features=AutomationControlled');
  });

  test('safe non-signal flags are still present in launcher source', () => {
    expect(launcherSource).toContain('--disable-background-networking');
    expect(launcherSource).toContain('--disable-sync');
    expect(launcherSource).toContain('--disable-translate');
  });
});

// ─── configurePageDefenses source verification ──────────────────────────────

describe('Stealth: configurePageDefenses source verification', () => {
  let clientSource: string;
  let defenseBlock: string;

  beforeAll(() => {
    const clientPath = path.join(__dirname, '../../src/cdp/client.ts');
    clientSource = fs.readFileSync(clientPath, 'utf8');

    // Extract the configurePageDefenses method definition body
    const methodSignature = 'configurePageDefenses(page: Page)';
    const methodStart = clientSource.indexOf(methodSignature);
    if (methodStart === -1) {
      throw new Error('configurePageDefenses method not found in client.ts');
    }
    const nextMethodComment = clientSource.indexOf('\n  /**', methodStart + methodSignature.length);
    defenseBlock = nextMethodComment > methodStart
      ? clientSource.slice(methodStart, nextMethodComment)
      : clientSource.slice(methodStart);
  });

  test('configurePageDefenses has exactly 3 evaluateOnNewDocument calls', () => {
    const evalCalls = (defenseBlock.match(/evaluateOnNewDocument/g) || []).length;
    expect(evalCalls).toBe(3);
  });

  test('stealth script covers all key fingerprinting vectors', () => {
    expect(defenseBlock).toContain('navigator.webdriver');
    expect(defenseBlock).toContain('navigator.plugins');
    expect(defenseBlock).toContain('navigator.languages');
    expect(defenseBlock).toContain('navigator.permissions');
    expect(defenseBlock).toContain('window.print');
  });

  test('comment accurately describes chrome.runtime patching', () => {
    expect(defenseBlock).not.toContain('chrome.csi');
    expect(defenseBlock).not.toContain('chrome.loadTimes');
    expect(defenseBlock).toContain('chrome.runtime');
  });

  test('Permissions API returns EventTarget-based PermissionStatus', () => {
    expect(defenseBlock).toContain('new EventTarget()');
    expect(defenseBlock).toContain("state: 'prompt'");
  });

  test('navigator.plugins override has configurable: true', () => {
    const pluginsStart = defenseBlock.indexOf("navigator, 'plugins'");
    expect(pluginsStart).toBeGreaterThan(-1);
    const pluginsEnd = defenseBlock.indexOf('// 4.', pluginsStart);
    const pluginsBlock = defenseBlock.slice(pluginsStart, pluginsEnd);
    expect(pluginsBlock).toContain('configurable: true');
  });

  test('notifications permission check is present', () => {
    expect(defenseBlock).toContain("params.name === 'notifications'");
  });
});
