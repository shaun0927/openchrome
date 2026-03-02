/**
 * Playwright Benchmark for Twitter/X Profile Scraping
 *
 * Connects to the same Chrome instance via CDP (port 9222)
 * to ensure identical auth state as OpenChrome.
 *
 * Measures:
 * - Wall clock time per profile
 * - Raw HTML size (what an LLM would need to process)
 * - innerText size (text-only extraction)
 * - Extracted tweet count and content
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { TARGETS, CDP_ENDPOINT, RESULTS_DIR } from './config.mjs';

mkdirSync(RESULTS_DIR, { recursive: true });

async function extractTweets(page) {
  return await page.evaluate(() => {
    const tweets = [];
    // Twitter/X tweet selectors
    const tweetElements = document.querySelectorAll('[data-testid="tweetText"]');
    tweetElements.forEach((el, i) => {
      if (i < 5) { // Top 5 tweets
        tweets.push(el.innerText.trim());
      }
    });
    return tweets;
  });
}

async function measurePageData(page) {
  return await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const text = document.body.innerText;
    return {
      htmlSize: html.length,
      textSize: text.length,
      // Approximate token count (1 token ≈ 4 chars for English)
      htmlTokens: Math.ceil(html.length / 4),
      textTokens: Math.ceil(text.length / 4),
    };
  });
}

async function run() {
  console.log('=== Playwright Benchmark: Twitter/X Profile Scraping ===\n');
  console.log(`Connecting to Chrome via CDP at ${CDP_ENDPOINT}...`);

  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  const results = [];
  const totalStart = Date.now();

  for (let i = 0; i < TARGETS.length; i++) {
    const target = TARGETS[i];
    const url = `https://x.com/${target.handle}`;
    console.log(`\n[${i + 1}/${TARGETS.length}] @${target.handle} (${target.name})`);

    const profileStart = Date.now();

    try {
      // Navigate to profile
      const navStart = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const navTime = Date.now() - navStart;

      // Wait for tweets to load
      const waitStart = Date.now();
      await page.waitForSelector('[data-testid="tweetText"]', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500); // Extra settle time
      const waitTime = Date.now() - waitStart;

      // Measure page data sizes
      const pageData = await measurePageData(page);

      // Extract tweets
      const tweets = await extractTweets(page);

      const totalTime = Date.now() - profileStart;

      const result = {
        handle: target.handle,
        name: target.name,
        success: tweets.length > 0,
        tweetCount: tweets.length,
        tweets: tweets,
        timing: {
          navigationMs: navTime,
          waitMs: waitTime,
          totalMs: totalTime,
        },
        dataSize: pageData,
      };

      results.push(result);
      console.log(`  ✓ ${tweets.length} tweets | ${totalTime}ms | HTML: ${(pageData.htmlSize / 1024).toFixed(0)}KB (~${pageData.htmlTokens} tokens)`);

    } catch (err) {
      const totalTime = Date.now() - profileStart;
      results.push({
        handle: target.handle,
        name: target.name,
        success: false,
        tweetCount: 0,
        tweets: [],
        timing: { totalMs: totalTime },
        dataSize: { htmlSize: 0, textSize: 0, htmlTokens: 0, textTokens: 0 },
        error: err.message,
      });
      console.log(`  ✗ FAILED: ${err.message} (${totalTime}ms)`);
    }
  }

  const totalTime = Date.now() - totalStart;

  // Summary
  const successful = results.filter(r => r.success);
  const totalHtmlTokens = results.reduce((sum, r) => sum + r.dataSize.htmlTokens, 0);
  const totalTextTokens = results.reduce((sum, r) => sum + r.dataSize.textTokens, 0);
  const avgTime = results.reduce((sum, r) => sum + r.timing.totalMs, 0) / results.length;
  const totalTweets = results.reduce((sum, r) => sum + r.tweetCount, 0);

  const summary = {
    approach: 'Playwright (CDP connection)',
    totalProfiles: TARGETS.length,
    successfulProfiles: successful.length,
    successRate: `${((successful.length / TARGETS.length) * 100).toFixed(1)}%`,
    totalTweetsExtracted: totalTweets,
    timing: {
      totalMs: totalTime,
      totalSec: (totalTime / 1000).toFixed(1),
      avgPerProfileMs: Math.round(avgTime),
    },
    tokenEstimate: {
      htmlMode: {
        totalTokens: totalHtmlTokens,
        avgPerProfile: Math.round(totalHtmlTokens / TARGETS.length),
        description: 'Raw HTML sent to LLM (page.content())',
      },
      textMode: {
        totalTokens: totalTextTokens,
        avgPerProfile: Math.round(totalTextTokens / TARGETS.length),
        description: 'innerText sent to LLM (page.innerText())',
      },
      scriptOverhead: {
        scriptTokens: 800, // Approximate tokens for this script
        description: 'One-time cost to generate the Playwright script',
      },
    },
    results,
  };

  console.log('\n=== SUMMARY ===');
  console.log(`Total time: ${summary.timing.totalSec}s`);
  console.log(`Success rate: ${summary.successRate}`);
  console.log(`Tweets extracted: ${totalTweets}`);
  console.log(`Avg time/profile: ${summary.timing.avgPerProfileMs}ms`);
  console.log(`Total HTML tokens: ${totalHtmlTokens.toLocaleString()} (avg ${summary.tokenEstimate.htmlMode.avgPerProfile.toLocaleString()}/profile)`);
  console.log(`Total text tokens: ${totalTextTokens.toLocaleString()} (avg ${summary.tokenEstimate.textMode.avgPerProfile.toLocaleString()}/profile)`);

  // Save results
  const outputPath = `${RESULTS_DIR}/playwright-results.json`;
  writeFileSync(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\nResults saved to ${outputPath}`);

  await page.close();
  // Don't close browser - it's the user's Chrome
}

run().catch(console.error);
