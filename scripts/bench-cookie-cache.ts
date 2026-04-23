#!/usr/bin/env ts-node
/**
 * Benchmark harness for issue #647: bound cookie caches and evict stale
 * entries on read-miss.
 *
 * Usage (standalone):
 *   npx ts-node scripts/bench-cookie-cache.ts
 *
 * The benchmark exercises ONLY the in-memory cookie cache paths on
 * CDPClient. It does not touch real Chrome. The assumption in the issue
 * is that per-tab cookie arrays are the dominant memory line; we simulate
 * a workload that mirrors `copyCookiesViaCDP`'s cache-write path across
 * 20 synthetic source tabs over a 10-minute simulated clock.
 *
 * Reports `heapUsed`/`rss` at t=0, t=10min and a JSON summary that the PR
 * template parses for the pre-merge gate (see issue §5.3).
 *
 * Logging: uses console.error only — stdout carries the JSON summary line
 * (last line) so tooling can pipe-grep the result. The JSON summary line
 * is the ONLY stdout write; every other print is stderr.
 */

/* eslint-disable no-console */

// Mock fetch so CDPClient constructor is happy even though we never actually connect.
(global as any).fetch = async () => {
  throw new Error('bench: fetch not used');
};

import { CDPClient } from '../src/cdp/client';

const NUM_TARGETS = 20;
const COOKIES_PER_TARGET = 40;
const NUM_CALLS = 200;
// Over a realistic 10-minute session, Chrome opens/closes many more than 20
// tabs; each closed tab's entry is only cleaned up by Target.targetDestroyed,
// and in practice that event is sometimes missed (abrupt Chrome crash,
// detached target). We simulate that by churning `CHURN_TABS` additional
// keys in the second half. On develop these accumulate; on patched they are
// FIFO-evicted once the cache exceeds COOKIE_DATA_CACHE_MAX (16).
const CHURN_TABS = 50;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

type CookieLike = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

function makeCookies(targetIdx: number, n: number): CookieLike[] {
  // Cookies of realistic shape so V8 retains the strings. Each cookie is
  // ~1–2 KB of live data once strings and the wrapper object are counted.
  return Array.from({ length: n }, (_, i) => ({
    name: `auth_cookie_${targetIdx}_${i}`.padEnd(48, 'x'),
    value: `opaque_token_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`.padEnd(
      1024,
      'y',
    ),
    domain: `tab${targetIdx}.example.com`,
    path: '/',
    expires: Date.now() / 1000 + 86400,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }));
}

function currentMem(): { heapUsed: number; rss: number } {
  const m = process.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss };
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runOnce(): Promise<{
  heapUsedAt0: number;
  heapUsedAt5: number;
  heapUsedAt10: number;
  rssAt0: number;
  rssAt5: number;
  rssAt10: number;
}> {
  const client = new CDPClient({ port: 9222 }) as unknown as {
    setCookieDataCacheEntry?: (k: string, v: { cookies: CookieLike[]; timestamp: number }) => void;
    cookieDataCache: Map<string, { cookies: CookieLike[]; timestamp: number }>;
    cookieSourceCache: Map<string, { targetId: string; timestamp: number }>;
  };

  // Detect whether we're on the patched build (helper method present).
  // If present, use it; otherwise fall back to the raw .set() pattern that
  // the baseline develop branch uses — that way the same script produces
  // comparable "pre-patch" numbers when executed on develop.
  const writeData = (key: string, cookies: CookieLike[], timestamp: number): void => {
    if (typeof client.setCookieDataCacheEntry === 'function') {
      client.setCookieDataCacheEntry(key, { cookies, timestamp });
    } else {
      client.cookieDataCache.set(key, { cookies, timestamp });
    }
  };

  // Injected clock. We advance it in lockstep with the simulated workload.
  let simulatedNow = 0;

  // Warm cache up with 20 synthetic source tabs' worth of cookies, each
  // recorded at t=0 of the simulated clock.
  const tabCookies: CookieLike[][] = [];
  for (let t = 0; t < NUM_TARGETS; t++) {
    tabCookies.push(makeCookies(t, COOKIES_PER_TARGET));
  }

  if (typeof (global as any).gc === 'function') (global as any).gc();
  const mem0 = currentMem();

  // Phase 1 — first 5 min: 200 copyCookies-style operations randomized
  // across the 20 pre-seeded targets. On develop (pre-patch) every .set()
  // updates the same key so no churn is visible; on patched the same.
  // This phase establishes a steady-state baseline.
  const halfway = Math.floor(NUM_CALLS / 2);
  for (let i = 0; i < NUM_CALLS; i++) {
    if (i < halfway) {
      simulatedNow = Math.floor((i / halfway) * FIVE_MINUTES_MS);
    } else {
      simulatedNow = FIVE_MINUTES_MS + Math.floor(((i - halfway) / (NUM_CALLS - halfway)) * FIVE_MINUTES_MS);
    }
    const targetIdx = Math.floor(Math.random() * NUM_TARGETS);
    writeData(`target-${targetIdx}`, tabCookies[targetIdx], simulatedNow);
  }

  if (typeof (global as any).gc === 'function') (global as any).gc();
  const mem5 = currentMem();

  // Phase 2 — next 5 min: tab churn. Each fresh tab's cookies are created
  // inline (so the cache is the ONLY reference). Baseline retains every
  // inserted key (no size cap) — 50 × ~44 KB ≈ 2.2 MB resident. Patched
  // retains only the last COOKIE_DATA_CACHE_MAX = 16 keys — the earlier 34
  // arrays become unreachable and get freed by GC.
  for (let t = 0; t < CHURN_TABS; t++) {
    simulatedNow = FIVE_MINUTES_MS + Math.floor((t / CHURN_TABS) * FIVE_MINUTES_MS);
    writeData(`churn-${t}`, makeCookies(NUM_TARGETS + t, COOKIES_PER_TARGET), simulatedNow);
  }

  if (typeof (global as any).gc === 'function') (global as any).gc();
  const mem10 = currentMem();

  // Keep a reference to the client so V8 cannot GC the cache between the
  // snapshot and the return.
  void client;

  return {
    heapUsedAt0: mem0.heapUsed,
    heapUsedAt5: mem5.heapUsed,
    heapUsedAt10: mem10.heapUsed,
    rssAt0: mem0.rss,
    rssAt5: mem5.rss,
    rssAt10: mem10.rss,
  };
}

async function main(): Promise<void> {
  const RUNS = 5;
  const heapDeltas: number[] = [];
  const rssDeltas: number[] = [];
  const samples: Array<Awaited<ReturnType<typeof runOnce>>> = [];

  for (let i = 0; i < RUNS; i++) {
    // Force GC between runs when possible for less noisy deltas.
    if (typeof (global as any).gc === 'function') {
      (global as any).gc();
    }
    const sample = await runOnce();
    samples.push(sample);
    heapDeltas.push(sample.heapUsedAt10 - sample.heapUsedAt0);
    rssDeltas.push(sample.rssAt10 - sample.rssAt0);
    console.error(
      `[bench] run ${i + 1}/${RUNS}: heapUsedΔ=${(heapDeltas[i] / 1024 / 1024).toFixed(2)} MB, rssΔ=${(rssDeltas[i] / 1024 / 1024).toFixed(2)} MB`,
    );
  }

  const medianHeapDeltaMB = median(heapDeltas) / 1024 / 1024;
  const medianRssDeltaMB = median(rssDeltas) / 1024 / 1024;

  const summary = {
    runs: RUNS,
    targets: NUM_TARGETS,
    cookiesPerTarget: COOKIES_PER_TARGET,
    calls: NUM_CALLS,
    simulatedDurationMs: TEN_MINUTES_MS,
    medianHeapDeltaBytes: median(heapDeltas),
    medianHeapDeltaMB: Number(medianHeapDeltaMB.toFixed(3)),
    medianRssDeltaBytes: median(rssDeltas),
    medianRssDeltaMB: Number(medianRssDeltaMB.toFixed(3)),
    samples: samples.map((s) => ({
      heapUsed: { at0: s.heapUsedAt0, at5: s.heapUsedAt5, at10: s.heapUsedAt10 },
      rss: { at0: s.rssAt0, at5: s.rssAt5, at10: s.rssAt10 },
    })),
  };

  // JSON summary is the ONLY stdout write — tooling parses the last line.
  process.stdout.write(JSON.stringify(summary) + '\n');
}

main().catch((err) => {
  console.error('[bench] fatal:', err);
  process.exit(1);
});
