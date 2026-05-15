/**
 * Raw Playwright — navigate to a URL and read the page text.
 * Idiomatic: browser/context/page lifecycle + page.textContent('body').
 */
import { chromium } from 'playwright';

export async function navigateAndRead(url: string): Promise<string> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  const text = (await page.textContent('body')) ?? '';
  await browser.close();
  return text;
}
