#!/usr/bin/env ts-node
/**
 * Perception benchmark CLI.
 *
 * Usage:
 *   npm run benchmark:perception
 *   npm run benchmark:perception -- --ci --json
 */

import { formatPerceptionReport, hasPerceptionFailures, runPerceptionBenchmark } from './perception';

function numberFlag(name: string, fallback: number): number {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  const parsed = Number(process.argv[idx + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const ci = process.argv.includes('--ci');
  const runs = numberFlag('--runs', 1);
  const report = await runPerceptionBenchmark({ runs });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPerceptionReport(report));
  }

  if (ci && hasPerceptionFailures(report)) {
    console.error('Perception benchmark guard failed. See task errors above.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Perception benchmark failed:', err);
  process.exit(1);
});
