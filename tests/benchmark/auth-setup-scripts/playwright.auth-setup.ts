/**
 * Playwright auth-setup script for the Auth & Real-World Usability axis (#1260).
 *
 * Playwright's documented best practice is `context.storageState({ path })`:
 * launch once, log in interactively, save the auth state, then load that
 * state in subsequent runs via `chromium.launch({ storageState })`. For the
 * reproducible tier this script drives the login form once and writes the
 * session cookie via `context.cookies()` instead — the same end state as
 * storageState() for a single-cookie auth wall.
 */

import { chromium, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import { AUTH_APP_CREDENTIALS } from '../fixtures/auth-app/server';

export async function playwrightAuthSetup(baseUrl: string, statePath: string): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.fill('input[name="username"]', AUTH_APP_CREDENTIALS.username);
  await page.fill('input[name="password"]', AUTH_APP_CREDENTIALS.password);
  await Promise.all([page.waitForURL(`${baseUrl}/`), page.click('button[type="submit"]')]);
  const cookies = await context.cookies();
  await fs.writeFile(statePath, JSON.stringify({ cookies }, null, 2));
  await browser.close();
}
