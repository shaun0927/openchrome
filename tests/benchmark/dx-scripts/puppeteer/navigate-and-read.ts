/**
 * Raw Puppeteer — navigate to a URL and read the page text.
 * Idiomatic: launch + page.evaluate to extract body text.
 */
import puppeteer from 'puppeteer-core';

export async function navigateAndRead(url: string, browserURL = 'http://127.0.0.1:9222'): Promise<string> {
  const browser = await puppeteer.connect({ browserURL });
  const page = await browser.newPage();
  await page.goto(url);
  const text = await page.evaluate(() => document.body.innerText);
  await page.close();
  await browser.disconnect();
  return text;
}
