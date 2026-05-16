#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';

import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';
import { captureEnvironment } from './utils/environment';
import { deterministicOpenChromeFixtureRuns, realWorldTaskSpecs } from './realworld-task-completion/fixtures';
import { aggregateRealWorldMetrics, assertHonestMeasurement } from './realworld-task-completion/scoring';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'realworld-task-completion.json');

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildRealWorldTaskCompletionResult() {
  const runs = deterministicOpenChromeFixtureRuns();
  assertHonestMeasurement(runs);
  const metrics = aggregateRealWorldMetrics(runs);
  const envelope = buildResultEnvelope({
    axis: 'realworld-task-completion',
    environment: captureEnvironment(),
    competitors: [
      {
        name: 'openchrome',
        version: readRepoVersion(),
      },
    ],
    results: [
      {
        suite: 'complex-real-world-task-completion',
        issue: '#1305',
        measurementMode: 'deterministic-fixture',
        claimScope: 'scaffold-only; not a live competitive measurement',
        tasks: realWorldTaskSpecs,
        runs,
        metrics,
      },
    ],
  });
  assertValidResultEnvelope(envelope);
  return envelope;
}

export function main(): void {
  const envelope = buildRealWorldTaskCompletionResult();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(envelope, null, 2) + '\n');

  const result = envelope.results[0];
  const metric = result.metrics[0];
  console.error('Complex Real-World Task Completion (#1305)');
  console.error(`mode: ${result.measurementMode}`);
  console.error(`claim: ${result.claimScope}`);
  console.error(`openchrome deterministic pass: ${(metric.successRate * 100).toFixed(1)}% (${metric.totalRuns}/${metric.totalRuns})`);
  console.error(`first-attempt: ${(metric.firstAttemptSuccessRate * 100).toFixed(1)}%; recovery: ${metric.recoverySuccessRate === null ? 'n/a' : `${(metric.recoverySuccessRate * 100).toFixed(1)}%`}`);
  console.error(`Saved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('real-world task-completion benchmark failed:', err);
    process.exit(1);
  }
}
