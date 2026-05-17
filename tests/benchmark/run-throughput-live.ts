import { launchManagedChrome, ManagedChrome } from './runtime/chrome-launcher';
import { parseThroughputArgs, runThroughputBenchmark, ThroughputRow } from './run-throughput';

export interface LiveThroughputExecutorOptions { argv: string[]; launchChrome: boolean; launcher?: (port: number) => Promise<ManagedChrome>; runBenchmark?: typeof runThroughputBenchmark; port?: number; }
export interface LiveThroughputExecutorResult { rows: ThroughputRow[]; cdpEndpoint: string; launchedChrome: boolean; failureCategory?: string; }

export async function runLiveThroughputExecutor(options: LiveThroughputExecutorOptions): Promise<LiveThroughputExecutorResult> {
  const port = options.port ?? 9222;
  let chrome: ManagedChrome | undefined;
  let cdpEndpoint = process.env.OPENCHROME_BENCH_CDP_ENDPOINT ?? `http://127.0.0.1:${port}`;
  try {
    if (options.launchChrome) chrome = await (options.launcher ?? ((p) => launchManagedChrome({ port: p })))(port);
    cdpEndpoint = chrome?.endpoint ?? cdpEndpoint;
    const previousEndpoint = process.env.OPENCHROME_BENCH_CDP_ENDPOINT;
    const previousChromePort = process.env.CHROME_PORT;
    const chromePort = new URL(cdpEndpoint).port || '9222';
    process.env.OPENCHROME_BENCH_CDP_ENDPOINT = cdpEndpoint;
    process.env.CHROME_PORT = chromePort;
    try {
      const args = parseThroughputArgs([...options.argv, '--live', `--cdp-endpoint=${cdpEndpoint}`]);
      const rows = await (options.runBenchmark ?? runThroughputBenchmark)(args);
      return { rows, cdpEndpoint, launchedChrome: Boolean(chrome) };
    } finally {
      if (previousEndpoint === undefined) delete process.env.OPENCHROME_BENCH_CDP_ENDPOINT;
      else process.env.OPENCHROME_BENCH_CDP_ENDPOINT = previousEndpoint;
      if (previousChromePort === undefined) delete process.env.CHROME_PORT;
      else process.env.CHROME_PORT = previousChromePort;
    }
  } catch (err) {
    return { rows: [], cdpEndpoint: chrome?.endpoint ?? cdpEndpoint, launchedChrome: Boolean(chrome), failureCategory: err instanceof Error ? err.message : String(err) };
  } finally {
    await chrome?.close();
  }
}
