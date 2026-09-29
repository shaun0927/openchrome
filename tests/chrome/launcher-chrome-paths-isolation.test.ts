/// <reference types="jest" />
/**
 * macOS headless bundle isolation (#613): headless Chrome must not run from the
 * user's Chrome.app, but must never open a profile with an older Chrome milestone.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findIsolatedMacHeadlessChrome,
  macChromeForTestingCandidates,
  readMacAppVersion,
} from '../../src/chrome/launcher-chrome-paths';

function fakeApp(root: string, appName: string, execName: string, version: string): string {
  const contents = path.join(root, `${appName}.app`, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0"?>\n<plist><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict></plist>\n`,
  );
  const exec = path.join(contents, 'MacOS', execName);
  fs.writeFileSync(exec, '');
  return exec;
}

const cft = (root: string, version: string) =>
  fakeApp(root, 'Google Chrome for Testing', 'Google Chrome for Testing', version);

describe('findIsolatedMacHeadlessChrome', () => {
  let tmp: string;
  let stable: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cft-'));
    stable = fakeApp(path.join(tmp, 'stable'), 'Google Chrome', 'Google Chrome', '154.0.8037.58');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('reads the bundle version', () => {
    expect(readMacAppVersion(stable)).toBe('154.0.8037.58');
    expect(readMacAppVersion(path.join(tmp, 'missing', 'x'))).toBeNull();
  });

  test('picks the newest Chrome for Testing at or above the stable major', () => {
    const same = cft(path.join(tmp, 'a'), '154.0.8037.10');
    const newer = cft(path.join(tmp, 'b'), '155.0.8100.2');
    expect(findIsolatedMacHeadlessChrome(stable, [same, newer])).toBe(newer);
    expect(findIsolatedMacHeadlessChrome(stable, [same])).toBe(same);
  });

  test('rejects an older milestone (profile downgrade)', () => {
    const older = cft(path.join(tmp, 'a'), '153.0.8010.12');
    expect(findIsolatedMacHeadlessChrome(stable, [older])).toBeNull();
  });

  test('keeps stable Chrome when versions are unreadable or nothing is installed', () => {
    const good = cft(path.join(tmp, 'a'), '154.0.1.1');
    expect(findIsolatedMacHeadlessChrome(path.join(tmp, 'no-stable', 'x'), [good])).toBeNull();
    expect(findIsolatedMacHeadlessChrome(stable, [path.join(tmp, 'nope', 'x')])).toBeNull();
  });

  test('discovers Playwright and Puppeteer cache layouts', () => {
    const pw = path.join(tmp, 'ms-playwright');
    const pptr = path.join(tmp, 'puppeteer');
    const pwExec = cft(path.join(pw, 'chromium-1243', 'chrome-mac-arm64'), '154.0.1.1');
    const pptrExec = cft(path.join(pptr, 'chrome', 'mac_arm-154.0.1.1', 'chrome-mac-arm64'), '154.0.1.1');
    const found = macChromeForTestingCandidates(
      { PLAYWRIGHT_BROWSERS_PATH: pw, PUPPETEER_CACHE_DIR: pptr },
      tmp,
    );
    expect(found).toEqual(expect.arrayContaining([pwExec, pptrExec]));
  });
});
