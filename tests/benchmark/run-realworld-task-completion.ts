#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';

import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';
import { captureEnvironment } from './utils/environment';
import { deterministicOpenChromeFixtureRuns, deterministicOpenChromeStressRuns, realWorldTaskSpecs } from './realworld-task-completion/fixtures';
import { competitorPinsFromRecordings, loadRecordedSamples, recordedSamplesToRuns } from './realworld-task-completion/recordings';
import { aggregateRealWorldMetrics, assertHonestMeasurement } from './realworld-task-completion/scoring';
import { evaluateEpisodeClaimEligibility } from './episode-harness/claim-eligibility';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'realworld-task-completion.json');

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

export function buildRealWorldTaskCompletionResult(argv: string[] = []) {
  const recordingDir = flagValue(argv, '--recording-dir');
  const stress = argv.includes('--stress');
  const recordedSamples = recordingDir ? loadRecordedSamples(recordingDir) : [];
  const runs = recordingDir ? recordedSamplesToRuns(recordedSamples) : stress ? deterministicOpenChromeStressRuns() : deterministicOpenChromeFixtureRuns();
  assertHonestMeasurement(runs);
  const metrics = aggregateRealWorldMetrics(runs);
  const finalPostconditionEvidence = runs
    .map((run) => run.finalPostconditionEvidence)
    .filter((evidence): evidence is string => typeof evidence === 'string' && evidence.trim().length > 0)
    .join('; ');
  const claimEligibility = evaluateEpisodeClaimEligibility({
    mode: recordingDir ? 'recorded-real' : 'scaffold',
    scope: 'aggregate',
    sampleCount: runs.length,
    finalPostconditionEvaluated: true,
    competitorVersionsPinned: recordingDir ? recordedSamples.every((sample) => sample.competitorVersion.length > 0) : true,
    sameTaskContracts: true,
    llmSettingsPinned: recordingDir ? recordedSamples.every((sample) => sample.llmModel.length > 0) : false,
  });
  const envelope = buildResultEnvelope({
    axis: 'realworld-task-completion',
    environment: captureEnvironment(),
    competitors: recordingDir ? competitorPinsFromRecordings(recordedSamples) : [
      {
        name: 'openchrome',
        version: readRepoVersion(),
      },
    ],
    results: [
      {
        suite: 'complex-real-world-task-completion',
        issue: stress ? '#1303/#1304' : '#1305',
        measurementMode: recordingDir ? 'recorded-real' : 'deterministic-fixture',
        claimScope: recordingDir
          ? 'recorded-real aggregate; eligible only if sample/version/LLM gates pass'
          : stress
            ? 'stress scaffold-only; faults injected inside local deterministic tasks, not a live competitive measurement'
            : 'scaffold-only; not a live competitive measurement',
        stressMode: stress,
        faultRows: runs.filter((run) => run.faultInjected === true),
        tasks: realWorldTaskSpecs,
        runs,
        metrics,
        finalPostconditionEvidence,
        finalPostconditionEvaluated: runs.length > 0 && runs.every((run) => run.finalPostconditionEvaluated === true || (typeof run.finalPostconditionEvidence === 'string' && run.finalPostconditionEvidence.trim().length > 0)),
        claimEligibility,
      },
    ],
  });
  assertValidResultEnvelope(envelope);
  return envelope;
}

export function main(): void {
  const envelope = buildRealWorldTaskCompletionResult(process.argv.slice(2));
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
