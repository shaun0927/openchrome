import { HarnessParallelRunner, HarnessScenario, sleep } from './parallel-runner';

interface SmokeResult {
  ok: boolean;
  kind: string;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function intArg(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const raw = args[key];
  if (typeof raw !== 'string') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function makeScenarios(args: Record<string, string | boolean>): HarnessScenario<SmokeResult>[] {
  const scenarios: HarnessScenario<SmokeResult>[] = [
    { id: 'fast-one', run: async () => ({ ok: true, kind: 'fast' }) },
    { id: 'fast-two', run: async () => ({ ok: true, kind: 'fast' }) },
    { id: 'fast-three', run: async () => ({ ok: true, kind: 'fast' }) },
  ];

  if (args['include-straggler-fixture']) {
    scenarios.push({
      id: 'intentional-straggler',
      run: async (signal) => {
        await sleep(150, signal);
        return { ok: true, kind: 'straggler' };
      },
    });
  }

  if (args['include-timeout-fixture']) {
    scenarios.push({
      id: 'intentional-timeout',
      run: async (signal) => {
        await sleep(10_000, signal);
        return { ok: true, kind: 'timeout-unexpected' };
      },
    });
  }

  if (args['include-failing-fixtures']) {
    scenarios.push({
      id: 'intentional-failure',
      run: async () => {
        throw new Error('intentional fixture failure');
      },
    });
    scenarios.push({ id: 'queued-after-failure', run: async () => ({ ok: true, kind: 'should-cancel' }) });
  }

  return scenarios;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const output = typeof args.output === 'string' ? args.output : 'artifacts/harness-parallel/latest.json';
  const runner = new HarnessParallelRunner<SmokeResult>({
    concurrency: intArg(args, 'concurrency', 2),
    scenarioTimeoutMs: intArg(args, 'scenario-timeout-ms', 1_000),
    maxErrors: intArg(args, 'max-errors', 5),
    stragglerAfterMs: intArg(args, 'straggler-after-ms', 50),
    partialWritePath: output,
  });

  const result = await runner.run(makeScenarios(args));
  console.log(JSON.stringify({
    completed: result.completed.length,
    failed: result.failed.length,
    timedOut: result.timedOut.length,
    cancelled: result.cancelled,
    stragglers: result.stragglers.length,
    output,
  }, null, 2));

  if (result.failed.length > 0 || result.timedOut.length > 0 || result.cancelled) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
