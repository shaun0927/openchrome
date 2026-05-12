/**
 * oc_performance_insights — Step 1 of the two-step performance flow (#846).
 *
 * Captures a CDP performance trace for the current page and turns it
 * into a list of named, severity-tagged insights. Returns a `trace_id`
 * handle the agent can drill into via `oc_performance_analyze`.
 *
 * Trace handles are scoped to the SessionManager session (NOT the OS
 * process). On `session:deleted`, the underlying trace files are
 * removed. See `src/core/performance/insights/trace-store.ts`.
 *
 * Tier: core. Off-switch: `OPENCHROME_PERF_INSIGHTS=0` skips registration.
 *
 * Scope reduction (vs. issue spec): this PR ships a hand-rolled v1
 * insights engine. The `chrome-devtools-frontend` vendoring +
 * `MANIFEST.txt` CI lint will land as a follow-up PR.
 */

import { CDPSession } from 'puppeteer-core';

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import {
  buildSummaryMarkdown,
  evaluateInsights,
  type TraceEventRecord,
} from '../core/performance/insights';
import { getPerfTraceStore } from '../core/performance/insights/trace-store';

/* Default categories — chrome-devtools-frontend's recording profile.
 * We omit the heavyweight `disabled-by-default-*` categories the
 * frontend uses for flame charts; v1 only consumes high-level
 * navigation, paint, layout-shift, and resource events. */
const DEFAULT_CATEGORIES = [
  'devtools.timeline',
  'loading',
  'navigation',
  'blink.user_timing',
  'latencyInfo',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
];

interface InsightsToolArgs {
  tabId?: string;
  url?: string;
  reload?: boolean;
  cpuThrottling?: number;
  network?: 'none' | 'slow-3g' | 'fast-3g' | 'slow-4g' | 'fast-4g';
  autoStop?: 'load' | 'idle' | { ms: number };
}

const definition: MCPToolDefinition = {
  name: 'oc_performance_insights',
  description:
    'Capture a CDP performance trace and return named insights ' +
    '(LCPBreakdown, DocumentLatency, RenderBlocking, CLSCulprits, ' +
    'LongTasks, ThirdParties). Returns a trace_id usable by ' +
    'oc_performance_analyze. Core-tier; trace handles are ' +
    'session-scoped and evicted on session close. Disable via ' +
    'OPENCHROME_PERF_INSIGHTS=0.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to trace. Required.',
      },
      url: {
        type: 'string',
        description: 'If set, navigate the tab to this URL before tracing.',
      },
      reload: {
        type: 'boolean',
        description: 'Reload the page after starting the trace (cold-load capture).',
      },
      cpuThrottling: {
        type: 'number',
        description: 'CPU throttling rate. 1 = none, 4 = mid-tier mobile.',
      },
      network: {
        type: 'string',
        enum: ['none', 'slow-3g', 'fast-3g', 'slow-4g', 'fast-4g'],
        description: 'Network throttling profile.',
      },
      autoStop: {
        oneOf: [
          { type: 'string', enum: ['load', 'idle'] },
          { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
        ],
        description:
          'When to stop tracing. "load" = page load event, "idle" = network idle, ' +
          '{ ms: N } = fixed timeout. Default 3000ms.',
      },
    },
    required: ['tabId'],
  },
};

interface NetworkConditions {
  offline: boolean;
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
}

const NETWORK_PRESETS: Record<NonNullable<InsightsToolArgs['network']>, NetworkConditions> = {
  none: { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
  'slow-3g': {
    offline: false,
    downloadThroughput: (500 * 1024) / 8,
    uploadThroughput: (500 * 1024) / 8,
    latency: 400,
  },
  'fast-3g': {
    offline: false,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 150,
  },
  'slow-4g': {
    offline: false,
    downloadThroughput: (3 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
    latency: 100,
  },
  'fast-4g': {
    offline: false,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (2 * 1024 * 1024) / 8,
    latency: 40,
  },
};

function jsonResult(payload: Record<string, unknown>): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...payload,
  };
}

function jsonError(message: string): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function jsonStructuredError(payload: Record<string, unknown>): MCPResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
    ...payload,
  };
}

/**
 * Tagged error used by the trace-collection branch when
 * `Tracing.tracingComplete` fails to fire within the configured budget.
 * The outer try/catch maps this to a structured tool result and the
 * `finally` block still runs (resetting emulation overrides).
 *
 * Distinct error class so the catch block can detect-and-shape the
 * payload without parsing message strings.
 */
class TracingCompleteTimeoutError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`Tracing.tracingComplete did not fire within ${elapsedMs}ms`);
    this.name = 'TracingCompleteTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Resolve the tracing-complete wait budget. Defaults to 5000ms; operators
 * can raise it for heavier pages via the env var. Values below 1000ms or
 * non-numeric are treated as the default to prevent foot-guns.
 */
function getTracingCompleteTimeoutMs(): number {
  const raw = process.env.OC_PERF_TRACING_COMPLETE_TIMEOUT_MS;
  if (!raw) return 5000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) return 5000;
  return Math.floor(parsed);
}

/**
 * Wait for either the page load event (`autoStop === 'load'`), the
 * network-idle marker (`autoStop === 'idle'`), or a fixed timeout. The
 * autoStop default is intentionally short (3000ms) so the tool stays
 * within the harness's tool-call timeout envelope.
 */
async function waitForAutoStop(
  page: {
    waitForNavigation: (opts: { waitUntil: 'load' | 'networkidle2'; timeout: number }) => Promise<unknown>;
  },
  autoStop: InsightsToolArgs['autoStop'],
): Promise<void> {
  const defaultMs = 3000;
  if (!autoStop) {
    await new Promise((r) => setTimeout(r, defaultMs));
    return;
  }
  if (typeof autoStop === 'object' && typeof autoStop.ms === 'number') {
    await new Promise((r) => setTimeout(r, autoStop.ms));
    return;
  }
  // 'load' | 'idle' — best-effort; on timeout we fall back to the
  // fixed window so the tool always returns within budget.
  const waitUntil: 'load' | 'networkidle2' = autoStop === 'idle' ? 'networkidle2' : 'load';
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil, timeout: 8000 }),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch {
    // ignore — we'll stop the trace regardless
  }
}

/**
 * Drive the CDP `Tracing` domain and collect every `dataCollected`
 * batch into a single TraceEventRecord array. Caller is responsible
 * for starting/stopping any extra emulation (CPU/network throttling).
 */
async function captureTrace(
  cdp: CDPSession,
  options: { categories: string[] },
): Promise<TraceEventRecord[]> {
  const events: TraceEventRecord[] = [];
  const onData = (msg: { value: TraceEventRecord[] }) => {
    if (Array.isArray(msg.value)) events.push(...msg.value);
  };
  cdp.on('Tracing.dataCollected', onData as never);
  const stoppedOnce = new Promise<void>((resolve) => {
    cdp.once('Tracing.tracingComplete', () => resolve());
  });
  try {
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      categories: options.categories.join(','),
    });
  } catch (err) {
    cdp.off('Tracing.dataCollected', onData as never);
    throw err;
  }
  return new Promise((resolve, reject) => {
    // Caller will trigger Tracing.end via the returned closure pattern;
    // here we just resolve when tracingComplete fires.
    stoppedOnce
      .then(() => {
        cdp.off('Tracing.dataCollected', onData as never);
        resolve(events);
      })
      .catch((err) => {
        cdp.off('Tracing.dataCollected', onData as never);
        reject(err);
      });
  });
}

const handler: ToolHandler = async (
  sessionId: string,
  rawArgs: Record<string, unknown>,
): Promise<MCPResult> => {
  const args = rawArgs as InsightsToolArgs;
  if (!args.tabId) return jsonError('tabId is required');

  const sm = getSessionManager();
  let page;
  try {
    page = await sm.getPage(sessionId, args.tabId, undefined, 'oc_performance_insights');
  } catch (err) {
    return jsonError(`getPage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!page) return jsonError(`Tab ${args.tabId} not found`);

  let cdp: CDPSession | undefined;
  // Track which emulation overrides were actually applied so the
  // finally block resets ONLY what we set. Without this, a throw
  // mid-trace would either skip the reset entirely (poisoning the tab
  // for subsequent tool calls in the same session) or reset overrides
  // that were never applied.
  let cpuApplied = false;
  let networkApplied = false;
  try {
    cdp = await page.createCDPSession();

    if (typeof args.cpuThrottling === 'number' && args.cpuThrottling > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: args.cpuThrottling });
      cpuApplied = true;
    }
    if (args.network && args.network !== 'none') {
      const preset = NETWORK_PRESETS[args.network];
      if (preset) {
        await cdp.send('Network.emulateNetworkConditions', preset);
        networkApplied = true;
      }
    }

    if (args.url) {
      try {
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        // Continue — partial load still produces useful trace data.
      }
    }

    // Start tracing AFTER any pre-navigation so the trace covers the
    // observed cold-load window when reload=true is set.
    const collectPromise = captureTrace(cdp, { categories: DEFAULT_CATEGORIES });

    if (args.reload) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        // ignore
      }
    }

    await waitForAutoStop(page, args.autoStop);

    // Stopping triggers the tracingComplete event the collector awaits.
    await cdp.send('Tracing.end');

    // If tracingComplete doesn't fire within the configured budget,
    // surface a structured timeout error instead of persisting a
    // half-built trace handle. Callers were previously fed an empty
    // event list and saw misleading "no data" insights for every metric.
    const timeoutMs = getTracingCompleteTimeoutMs();
    const events = await Promise.race([
      collectPromise,
      new Promise<TraceEventRecord[]>((_resolve, reject) =>
        setTimeout(() => reject(new TracingCompleteTimeoutError(timeoutMs)), timeoutMs),
      ),
    ]);

    const trace = { traceEvents: events };
    const { summaries } = evaluateInsights(trace);
    const summaryMd = buildSummaryMarkdown(summaries);

    const handle = getPerfTraceStore().store({
      sessionId,
      events,
      metadata: {
        url: args.url,
        reload: args.reload,
        cpuThrottling: args.cpuThrottling,
        network: args.network,
        autoStop: args.autoStop,
      },
    });

    return jsonResult({
      trace_id: handle.trace_id,
      trace_path: handle.trace_path,
      summary_md: summaryMd,
      insights: summaries,
    });
  } catch (err) {
    if (err instanceof TracingCompleteTimeoutError) {
      // Crucially: NO trace handle is created here — callers should not
      // see a half-built handle that yields empty insights.
      return jsonStructuredError({
        error: 'tracing_complete_timeout',
        elapsed_ms: err.elapsedMs,
        hint: 'Increase OC_PERF_TRACING_COMPLETE_TIMEOUT_MS for heavy pages',
      });
    }
    return jsonError(
      `oc_performance_insights failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Always reset emulation overrides we applied — a throw between
    // `setCPUThrottlingRate(rate>1)` / `emulateNetworkConditions(...)`
    // and the end of the success block would otherwise leave the tab
    // throttled for subsequent tool calls in this session.
    if (cdp) {
      if (cpuApplied) {
        try {
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        } catch {
          /* best-effort */
        }
      }
      if (networkApplied) {
        try {
          await cdp.send('Network.emulateNetworkConditions', NETWORK_PRESETS.none);
        } catch {
          /* best-effort */
        }
      }
      try {
        await cdp.detach();
      } catch {
        /* ignore */
      }
    }
  }
};

export function registerOcPerformanceInsightsTool(server: MCPServer): void {
  server.registerTool('oc_performance_insights', handler, definition);
}
