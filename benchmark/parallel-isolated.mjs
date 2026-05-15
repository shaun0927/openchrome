/**
 * Isolated Parallel Benchmark — Playwright only. **LEGACY.**
 *
 * This file is the original Twitter/X scraping benchmark — Playwright
 * measurements only, no estimation. It is **superseded** by the unified
 * competitive benchmark harness (#1258 / Epic #1254):
 *
 *   For OpenChrome vs competitor throughput, use:
 *     npm run bench:throughput            (deterministic stub, CI)
 *     OPENCHROME_BENCH_LIVE=1 \
 *       npm run bench:throughput          (real Chrome on :9222)
 *
 * The unified harness covers the same throughput question and produces a
 * schema-valid result envelope at `benchmark/results/speed-throughput.json`
 * that the next-session report generator consumes.
 *
 * This script remains functional for the legacy Twitter/X scenario. It
 * previously *estimated* OpenChrome token counts via a hard-coded
 * compression ratio — that estimation was removed by Epic #1254 sub-issue
 * #1255. Today it measures only real Playwright wall-clock + raw HTML
 * sizes.
 *
 * Usage:
 *   node parallel-isolated.mjs 1    # sequential (1 tab)
 *   node parallel-isolated.mjs 5    # batches of 5
 *   node parallel-isolated.mjs 10   # batches of 10
 *   node parallel-isolated.mjs 20   # all 20 at once
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { TARGETS, CDP_ENDPOINT, RESULTS_DIR } from './config.mjs';

const BATCH_SIZE = parseInt(process.argv[2] || '1', 10);

async function extractFromPage(page, target) {
  const start = Date.now();
  try {
    await page.goto(`https://x.com/${target.handle}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await page.waitForSelector('[data-testid="tweetText"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const text = document.body.innerText;
      const tweets = [...document.querySelectorAll('[data-testid="tweetText"]')]
        .slice(0, 5)
        .map(el => el.innerText.trim());
      return { rawHtmlChars: html.length, rawTextChars: text.length, tweetCount: tweets.length, tweets };
    });

    const totalTime = Date.now() - start;

    return {
      handle: target.handle,
      name: target.name,
      success: data.tweetCount > 0,
      tweetCount: data.tweetCount,
      tweets: data.tweets,
      timing: { totalMs: totalTime },
      // Real Playwright measurements only — no estimated OpenChrome figures.
      dataSize: {
        rawHtmlChars: data.rawHtmlChars,
        rawTextChars: data.rawTextChars,
      },
    };
  } catch (err) {
    return {
      handle: target.handle, name: target.name,
      success: false, tweetCount: 0, tweets: [],
      timing: { totalMs: Date.now() - start },
      dataSize: { rawHtmlChars: 0, rawTextChars: 0 },
      error: err.message,
    };
  }
}

async function run() {
  const label = BATCH_SIZE === 1 ? 'Sequential' : `Parallel (${BATCH_SIZE}-batch)`;
  console.log(`=== ${label} Benchmark ===`);
  console.log(`Batch size: ${BATCH_SIZE} | Profiles: ${TARGETS.length}\n`);

  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];

  const allResults = [];
  const totalStart = Date.now();

  if (BATCH_SIZE === 1) {
    // Sequential
    const page = await context.newPage();
    for (let i = 0; i < TARGETS.length; i++) {
      const target = TARGETS[i];
      console.log(`[${i + 1}/${TARGETS.length}] @${target.handle}`);
      const result = await extractFromPage(page, target);
      allResults.push(result);
      const s = result.success ? '✓' : '✗';
      console.log(`  ${s} ${result.tweetCount} tweets | ${result.timing.totalMs}ms`);
    }
    await page.close();
  } else {
    // Parallel in batches
    for (let i = 0; i < TARGETS.length; i += BATCH_SIZE) {
      const batch = TARGETS.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const batchStart = Date.now();
      console.log(`--- Batch ${batchNum} (${batch.length} tabs) ---`);

      const pages = await Promise.all(batch.map(() => context.newPage()));
      const results = await Promise.all(
        batch.map((target, j) => extractFromPage(pages[j], target))
      );

      for (const r of results) {
        const s = r.success ? '✓' : '✗';
        console.log(`  ${s} @${r.handle}: ${r.tweetCount} tweets | ${r.timing.totalMs}ms`);
      }
      console.log(`  Batch time: ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);

      allResults.push(...results);
      await Promise.all(pages.map(p => p.close()));
    }
  }

  const totalTime = Date.now() - totalStart;
  const successful = allResults.filter(r => r.success);
  const totalTweets = allResults.reduce((s, r) => s + r.tweetCount, 0);
  const totalOcTokens = allResults.reduce((s, r) => s + r.dataSize.ocCompactTokens, 0);
  const totalRawTokens = allResults.reduce((s, r) => s + r.dataSize.rawHtmlTokens, 0);

  const summary = {
    strategy: label,
    batchSize: BATCH_SIZE,
    totalProfiles: TARGETS.length,
    successfulProfiles: successful.length,
    successRate: ((successful.length / TARGETS.length) * 100).toFixed(1),
    totalTweetsExtracted: totalTweets,
    timing: {
      totalMs: totalTime,
      totalSec: (totalTime / 1000).toFixed(1),
      avgPerProfileMs: Math.round(totalTime / TARGETS.length),
    },
    tokenEstimate: {
      ocCompactTotal: totalOcTokens,
      rawHtmlTotal: totalRawTokens,
      ocCompactAvg: Math.round(totalOcTokens / TARGETS.length),
    },
    results: allResults,
  };

  console.log(`\n=== RESULT: ${label} ===`);
  console.log(`Time: ${summary.timing.totalSec}s | Success: ${summary.successRate}% | Tweets: ${totalTweets}`);

  const filename = `isolated-batch${BATCH_SIZE}.json`;
  writeFileSync(`${RESULTS_DIR}/${filename}`, JSON.stringify(summary, null, 2));
  console.log(`Saved: ${filename}`);

  // Output machine-readable summary line
  console.log(`\n[RESULT] batch=${BATCH_SIZE} time=${summary.timing.totalSec}s success=${summary.successRate}% tweets=${totalTweets}`);
}

run().catch(console.error);
