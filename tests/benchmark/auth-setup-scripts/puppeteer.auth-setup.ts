/**
 * Puppeteer auth-setup script for the Auth & Real-World Usability axis (#1260).
 *
 * Puppeteer's documented best practice for auth reuse is `userDataDir`:
 * launch with a persistent profile directory and let the in-browser cookie
 * jar carry the auth between runs. For the reproducible tier this script
 * uses the explicit cookie-jar API (the lower-level primitive userDataDir
 * persists internally) so the LOC count reflects the cookie-handling code
 * a real script would write rather than just the launch line.
 */

import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs/promises';
import { AUTH_APP_CREDENTIALS } from '../fixtures/auth-app/server';

export async function puppeteerAuthSetup(baseUrl: string, cookiesPath: string): Promise<void> {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.type('input[name="username"]', AUTH_APP_CREDENTIALS.username);
  await page.type('input[name="password"]', AUTH_APP_CREDENTIALS.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.click('button[type="submit"]'),
  ]);
  const cookies = await page.cookies();
  await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
  await browser.disconnect();
}
