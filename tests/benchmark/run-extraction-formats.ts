#!/usr/bin/env ts-node
import { formatExtractionFormatsReport, runExtractionFormatsBenchmark } from './tasks/extraction-formats';

async function main(): Promise<void> {
  const ciMode = process.argv.includes('--ci');
  const report = runExtractionFormatsBenchmark({ ciMode });
  if (report.summary.failures > 0) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (ciMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatExtractionFormatsReport(report));
  }
}

main().catch((err) => {
  console.error('Extraction format benchmark failed:', err);
  process.exit(1);
});
