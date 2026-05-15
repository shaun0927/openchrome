/**
 * Raw Puppeteer — fill a form and submit.
 * Idiomatic: page.type per field + page.click + waitForNavigation.
 */
import puppeteer from 'puppeteer-core';

export async function formFill(
  url: string,
  fields: Record<string, string>,
  browserURL = 'http://127.0.0.1:9222',
): Promise<void> {
  const browser = await puppeteer.connect({ browserURL });
  const page = await browser.newPage();
  await page.goto(url);
  for (const [name, value] of Object.entries(fields)) {
    await page.type(`input[name="${name}"]`, value);
  }
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await page.close();
  await browser.disconnect();
}
