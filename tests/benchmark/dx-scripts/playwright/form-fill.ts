/**
 * Raw Playwright — fill a form and submit.
 * Idiomatic: page.fill per field + page.click submit + wait for navigation.
 */
import { chromium } from 'playwright';

export async function formFill(url: string, fields: Record<string, string>): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  for (const [name, value] of Object.entries(fields)) {
    await page.fill(`input[name="${name}"]`, value);
  }
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await browser.close();
}
