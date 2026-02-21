/**
 * Real E2E test: 20-site parallel crawling via CDP
 *
 * Connects to your running Chrome (port 9222), creates 20 isolated
 * browser contexts, navigates each to a real website IN PARALLEL,
 * extracts actual page content (title, description, headings, links, text),
 * and measures wall-clock time.
 *
 * Usage: npx ts-node tests/e2e/parallel-crawl-real.ts
 */

import puppeteer, { Browser } from 'puppeteer-core';

const SITES = [
  'https://www.google.com',
  'https://www.github.com',
  'https://www.stackoverflow.com',
  'https://www.wikipedia.org',
  'https://www.reddit.com',
  'https://www.amazon.com',
  'https://www.youtube.com',
  'https://www.twitter.com',
  'https://www.linkedin.com',
  'https://www.apple.com',
  'https://www.microsoft.com',
  'https://www.npmjs.com',
  'https://www.cloudflare.com',
  'https://www.stripe.com',
  'https://www.vercel.com',
  'https://www.netlify.com',
  'https://www.docker.com',
  'https://www.mozilla.org',
  'https://www.rust-lang.org',
  'https://www.python.org',
];

interface ExtractedData {
  title: string;
  description: string;
  h1: string[];
  linkCount: number;
  imageCount: number;
  textLength: number;
  textSnippet: string;
}

interface CrawlResult {
  site: string;
  status: 'success' | 'error';
  durationMs: number;
  data?: ExtractedData;
  error?: string;
}

async function crawlSite(browser: Browser, url: string): Promise<CrawlResult> {
  const start = Date.now();
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Extract real content from the page
    const data: ExtractedData = await page.evaluate(() => {
      const title = document.title || '';
      const metaDesc = document.querySelector('meta[name="description"]');
      const description = metaDesc ? metaDesc.getAttribute('content') || '' : '';
      const h1Elements = Array.from(document.querySelectorAll('h1'));
      const h1 = h1Elements.map(el => (el.textContent || '').trim().slice(0, 80)).filter(Boolean).slice(0, 3);
      const linkCount = document.querySelectorAll('a[href]').length;
      const imageCount = document.querySelectorAll('img').length;
      const bodyText = (document.body?.innerText || '').trim();
      const textLength = bodyText.length;
      const textSnippet = bodyText.slice(0, 200).replace(/\s+/g, ' ');
      return { title, description, h1, linkCount, imageCount, textLength, textSnippet };
    });

    const duration = Date.now() - start;
    await context.close();
    return { site: url, status: 'success', durationMs: duration, data };
  } catch (err) {
    const duration = Date.now() - start;
    await context.close().catch(() => {});
    return {
      site: url,
      status: 'error',
      durationMs: duration,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`\n🚀 OpenChrome Real Parallel Crawl Test — ${SITES.length} sites\n`);
  console.log('Connecting to Chrome on localhost:9222...');

  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9222',
  });

  console.log('Connected. Launching parallel crawl with data extraction...\n');

  // === PARALLEL ===
  const parallelStart = Date.now();
  const results = await Promise.all(SITES.map(url => crawlSite(browser, url)));
  const parallelTotal = Date.now() - parallelStart;

  const successes = results.filter(r => r.status === 'success');
  const failures = results.filter(r => r.status === 'error');

  // === DETAILED RESULTS ===
  console.log('═'.repeat(90));
  console.log('  CRAWL RESULTS');
  console.log('═'.repeat(90));

  for (const r of results) {
    const icon = r.status === 'success' ? '✓' : '✗';
    const host = new URL(r.site).hostname;
    console.log(`\n  ${icon} ${host} (${r.durationMs}ms)`);

    if (r.data) {
      console.log(`    Title:       ${r.data.title.slice(0, 60)}`);
      if (r.data.description) {
        console.log(`    Description: ${r.data.description.slice(0, 70)}...`);
      }
      if (r.data.h1.length > 0) {
        console.log(`    H1:          ${r.data.h1[0].slice(0, 60)}`);
      }
      console.log(`    Links: ${r.data.linkCount} | Images: ${r.data.imageCount} | Text: ${(r.data.textLength / 1024).toFixed(1)}KB`);
      console.log(`    Snippet:     "${r.data.textSnippet.slice(0, 80)}..."`);
    } else if (r.error) {
      console.log(`    Error: ${r.error}`);
    }
  }

  // === TIMING SUMMARY ===
  const sequentialEstimate = results.reduce((sum, r) => sum + r.durationMs, 0);
  const totalLinks = successes.reduce((sum, r) => sum + (r.data?.linkCount || 0), 0);
  const totalImages = successes.reduce((sum, r) => sum + (r.data?.imageCount || 0), 0);
  const totalTextKB = successes.reduce((sum, r) => sum + (r.data?.textLength || 0), 0) / 1024;

  console.log('\n' + '═'.repeat(90));
  console.log('  SUMMARY');
  console.log('═'.repeat(90));
  console.log(`\n📊 Performance:`);
  console.log(`   Sites crawled:      ${SITES.length}`);
  console.log(`   Successful:         ${successes.length}`);
  console.log(`   Failed:             ${failures.length}`);
  console.log(`   Parallel total:     ${parallelTotal}ms (${(parallelTotal / 1000).toFixed(1)}s)`);
  console.log(`   Sequential sum:     ${sequentialEstimate}ms (${(sequentialEstimate / 1000).toFixed(1)}s)`);
  console.log(`   Speedup:            ${(sequentialEstimate / parallelTotal).toFixed(1)}x`);

  const slowest = results.reduce((a, b) => (a.durationMs > b.durationMs ? a : b));
  const fastest = results.reduce((a, b) => (a.durationMs < b.durationMs ? a : b));
  console.log(`   Fastest:            ${new URL(fastest.site).hostname} (${fastest.durationMs}ms)`);
  console.log(`   Slowest:            ${new URL(slowest.site).hostname} (${slowest.durationMs}ms)`);

  console.log(`\n📦 Data Extracted:`);
  console.log(`   Total links:        ${totalLinks}`);
  console.log(`   Total images:       ${totalImages}`);
  console.log(`   Total text:         ${totalTextKB.toFixed(1)}KB`);
  console.log(`   Avg text/site:      ${(totalTextKB / successes.length).toFixed(1)}KB`);

  console.log(`\n💡 Wall-clock: ${(parallelTotal / 1000).toFixed(1)}s for ${SITES.length} sites`);
  console.log(`   Sequential would take: ${(sequentialEstimate / 1000).toFixed(1)}s`);
  console.log(`   Time saved: ${((sequentialEstimate - parallelTotal) / 1000).toFixed(1)}s\n`);

  await browser.disconnect();

  if (successes.length >= 15) {
    console.log('✅ PASS: 20-site parallel crawl with data extraction verified\n');
    process.exit(0);
  } else {
    console.log(`❌ FAIL: Only ${successes.length}/${SITES.length} sites succeeded\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
