/**
 * v1 hand-rolled performance-insight evaluators (#846).
 *
 * Six evaluators consume a CDP trace document and produce a one-line
 * summary plus a Markdown drill-down. The evaluators are intentionally
 * conservative — they extract a small number of well-known events and
 * derive a single causal narrative each, rather than attempting to
 * replicate the full chrome-devtools-frontend Insight engine.
 *
 * The follow-up PR vendoring `chrome-devtools-frontend` will replace the
 * bodies of these functions with calls into the upstream insight modules.
 * The public surface (one_line + details_md + evidence[]) is designed so
 * that swap is a non-breaking change for the MCP tool layer.
 */

import { scrubString } from '../../trace/redactor';
import type {
  EvaluatorFn,
  EvaluatorResult,
  InsightDetails,
  InsightName,
  InsightSummary,
  TraceDocument,
  TraceEventRecord,
} from './types';

/** Microseconds → milliseconds, rounded to 1 decimal. */
function usToMs(us: number): number {
  return Math.round(us / 100) / 10;
}

/** Milliseconds → "1.2s" or "950ms" for human-readable summaries. */
function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/** Pick a tier label from a numeric ms threshold. */
function severityForMs(
  ms: number,
  warnAt: number,
  critAt: number,
): InsightSummary['severity'] {
  if (ms >= critAt) return 'critical';
  if (ms >= warnAt) return 'warn';
  return 'info';
}

/** Filter helper: events whose category list contains `wanted`. */
function eventsInCategory(events: TraceEventRecord[], wanted: string): TraceEventRecord[] {
  return events.filter((e) => {
    if (!e.cat) return false;
    return e.cat.split(',').some((c) => c.trim() === wanted);
  });
}

/** Filter helper: events with a matching `name`. */
function eventsByName(events: TraceEventRecord[], name: string): TraceEventRecord[] {
  return events.filter((e) => e.name === name);
}

/** Try to extract a hostname from a URL string; falls back to the input. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Redact a URL before embedding it in a Markdown details string. The
 * trace redactor scrubs query-string credentials, JWTs, and other
 * patterns; the result is safe to surface back to the agent.
 */
function safeUrl(url: string): string {
  return scrubString(url);
}

/** Build a no-data placeholder result for a given insight. */
function noData(insight: InsightName, reason?: string): EvaluatorResult {
  const reasonSuffix = reason ? ` (${reason})` : '';
  const summary: InsightSummary = {
    name: insight,
    severity: 'info',
    one_line: `no data${reasonSuffix}`,
  };
  const reasonLine = reason ? `\n\n**Reason**: \`${reason}\`` : '';
  const details: InsightDetails = {
    insight,
    details_md: `# ${insight}\n\nNo trace events matched this insight.${reasonLine}`,
    evidence: reason ? [{ kind: 'metric', ref: `reason=${reason}` }] : [],
  };
  return { summary, details };
}

/**
 * Find the trace-clock timestamp of the first `navigationStart` event.
 * Chrome trace events use a tracing-clock (μs since an arbitrary epoch),
 * NOT elapsed time since navigation. To convert a raw `ts` into an
 * elapsed-since-nav value, callers must subtract this navStart.
 *
 * Returns `undefined` if no navigationStart marker is present — in that
 * case evaluators that depend on a nav-relative timeline (LCP, FCP)
 * should surface `no_data` with reason `unknown_navigation_start` rather
 * than emit a multi-billion-millisecond bogus value.
 */
function findNavigationStartTs(trace: TraceDocument): number | undefined {
  for (const e of trace.traceEvents) {
    if (e.name !== 'navigationStart') continue;
    if (typeof e.ts !== 'number') continue;
    // Accept the conventional categories: blink.user_timing, loading,
    // and the bare event (older traces). The first matching event wins.
    const cats = typeof e.cat === 'string' ? e.cat.split(',').map((c) => c.trim()) : [];
    if (
      cats.length === 0 ||
      cats.includes('blink.user_timing') ||
      cats.includes('loading') ||
      cats.includes('navigation')
    ) {
      return e.ts;
    }
  }
  return undefined;
}

/* ──────────────────────────────────────────────────────────────────── */
/* LCPBreakdown                                                         */
/* ──────────────────────────────────────────────────────────────────── */

interface LcpCandidate {
  ts: number;
  size: number;
  url?: string;
  nodeName?: string;
}

function extractLcpCandidates(trace: TraceDocument): LcpCandidate[] {
  const out: LcpCandidate[] = [];
  for (const e of trace.traceEvents) {
    if (
      e.name === 'largestContentfulPaint::Candidate' ||
      e.name === 'LargestContentfulPaint::Candidate'
    ) {
      const args = (e.args ?? {}) as Record<string, unknown>;
      const data = (args.data ?? args) as Record<string, unknown>;
      const size =
        typeof data.size === 'number'
          ? data.size
          : typeof data.candidateSize === 'number'
            ? (data.candidateSize as number)
            : 0;
      const url = typeof data.url === 'string' ? data.url : undefined;
      const nodeName = typeof data.nodeName === 'string' ? data.nodeName : undefined;
      out.push({ ts: typeof e.ts === 'number' ? e.ts : 0, size, url, nodeName });
    }
  }
  return out;
}

const lcpBreakdown: EvaluatorFn = (trace) => {
  const candidates = extractLcpCandidates(trace);
  if (candidates.length === 0) return null;
  // Last candidate is the final LCP (CDP convention).
  const winner = candidates[candidates.length - 1];
  // Chrome trace `ts` values are tracing-clock μs, not elapsed-since-nav.
  // We must normalize to navigation-start so reported LCP is a sane
  // millisecond figure (vs. multi-billion μs from the tracing-clock epoch).
  const navStart = findNavigationStartTs(trace);
  if (navStart === undefined || winner.ts <= navStart) {
    return noData('LCPBreakdown', 'unknown_navigation_start');
  }
  const lcpMs = usToMs(winner.ts - navStart);
  const severity = severityForMs(lcpMs, 2500, 4000);
  const target = winner.url
    ? safeUrl(winner.url)
    : winner.nodeName
      ? `<${winner.nodeName}>`
      : 'unknown element';
  const summary: InsightSummary = {
    name: 'LCPBreakdown',
    severity,
    one_line: `LCP ${fmtMs(lcpMs)} — largest contributor: ${target}`,
  };
  const lines: string[] = [
    `# LCPBreakdown`,
    ``,
    `**LCP**: ${fmtMs(lcpMs)} (${severity})`,
    ``,
    `**Largest contributor**: ${target}`,
  ];
  if (typeof winner.size === 'number' && winner.size > 0) {
    lines.push(`**Element size**: ${winner.size}px`);
  }
  if (candidates.length > 1) {
    lines.push(``, `**Candidates seen**: ${candidates.length}`);
  }
  const evidence: InsightDetails['evidence'] = [];
  if (winner.url) {
    evidence.push({ kind: 'request', ref: safeUrl(winner.url) });
  }
  evidence.push({ kind: 'metric', ref: `LCP=${fmtMs(lcpMs)}` });
  return {
    summary,
    details: { insight: 'LCPBreakdown', details_md: lines.join('\n'), evidence },
  };
};

/* ──────────────────────────────────────────────────────────────────── */
/* DocumentLatency                                                      */
/* ──────────────────────────────────────────────────────────────────── */

const documentLatency: EvaluatorFn = (trace) => {
  // Look for the main resourceSendRequest + resourceReceiveResponse pair
  // for the top-level navigation document. We identify the document
  // request via `args.data.resourceType === 'Document'` if present, else
  // by being the earliest resourceSendRequest.
  const sends = eventsByName(trace.traceEvents, 'ResourceSendRequest');
  const receives = eventsByName(trace.traceEvents, 'ResourceReceiveResponse');
  if (sends.length === 0 && receives.length === 0) return null;

  let docSend: TraceEventRecord | undefined;
  for (const ev of sends) {
    const data = ((ev.args ?? {}) as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    if (data && (data.resourceType === 'Document' || data.requestPriority === 'VeryHigh')) {
      docSend = ev;
      break;
    }
  }
  if (!docSend && sends.length > 0) {
    docSend = sends.reduce((a, b) => ((a.ts ?? 0) <= (b.ts ?? 0) ? a : b));
  }
  if (!docSend) return null;

  const sendData = ((docSend.args ?? {}) as Record<string, unknown>).data as
    | Record<string, unknown>
    | undefined;
  const requestId = sendData && typeof sendData.requestId === 'string' ? sendData.requestId : undefined;
  const url = sendData && typeof sendData.url === 'string' ? sendData.url : undefined;

  let docReceive: TraceEventRecord | undefined;
  if (requestId) {
    docReceive = receives.find((r) => {
      const d = ((r.args ?? {}) as Record<string, unknown>).data as
        | Record<string, unknown>
        | undefined;
      return d && d.requestId === requestId;
    });
  }
  docReceive ??= receives[0];

  const sendTs = typeof docSend.ts === 'number' ? docSend.ts : 0;
  const recvTs = docReceive && typeof docReceive.ts === 'number' ? docReceive.ts : sendTs;
  const ttfbMs = usToMs(Math.max(0, recvTs - sendTs));
  const severity = severityForMs(ttfbMs, 600, 1500);

  const summary: InsightSummary = {
    name: 'DocumentLatency',
    severity,
    one_line: `Document TTFB ${fmtMs(ttfbMs)}${url ? ` for ${hostnameOf(url)}` : ''}`,
  };

  const lines = [
    `# DocumentLatency`,
    ``,
    `**TTFB**: ${fmtMs(ttfbMs)} (${severity})`,
  ];
  if (url) lines.push(`**Document URL host**: ${hostnameOf(url)}`);
  if (requestId) lines.push(`**Request ID**: ${requestId}`);

  const evidence: InsightDetails['evidence'] = [];
  if (url) evidence.push({ kind: 'request', ref: safeUrl(url) });
  evidence.push({ kind: 'metric', ref: `TTFB=${fmtMs(ttfbMs)}` });

  return {
    summary,
    details: { insight: 'DocumentLatency', details_md: lines.join('\n'), evidence },
  };
};

/* ──────────────────────────────────────────────────────────────────── */
/* RenderBlocking                                                       */
/* ──────────────────────────────────────────────────────────────────── */

const renderBlocking: EvaluatorFn = (trace) => {
  // Render-blocking resources are reported via ResourceSendRequest with
  // `args.data.renderBlocking === 'blocking'` (Chrome ≥ 110). Older
  // traces use `args.data.renderBlocking === true`. We accept both.
  const sends = eventsByName(trace.traceEvents, 'ResourceSendRequest');
  const blocking: { url: string; type: string }[] = [];
  for (const ev of sends) {
    const data = ((ev.args ?? {}) as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    if (!data) continue;
    const rb = data.renderBlocking;
    const isBlocking = rb === 'blocking' || rb === 'in_body_parser_blocking' || rb === true;
    if (!isBlocking) continue;
    const url = typeof data.url === 'string' ? data.url : '';
    if (!url) continue;
    const type = typeof data.resourceType === 'string' ? (data.resourceType as string) : 'Other';
    blocking.push({ url, type });
  }

  if (blocking.length === 0) {
    return {
      summary: {
        name: 'RenderBlocking',
        severity: 'info',
        one_line: 'no render-blocking resources detected',
      },
      details: {
        insight: 'RenderBlocking',
        details_md: `# RenderBlocking\n\nNo render-blocking resources detected in this trace.`,
        evidence: [],
      },
    };
  }

  const severity = blocking.length >= 5 ? 'critical' : blocking.length >= 2 ? 'warn' : 'info';
  const summary: InsightSummary = {
    name: 'RenderBlocking',
    severity,
    one_line: `${blocking.length} render-blocking resource${blocking.length === 1 ? '' : 's'}`,
  };
  const lines = [`# RenderBlocking`, ``, `**Count**: ${blocking.length}`, ``, `## Resources`, ``];
  for (const r of blocking.slice(0, 20)) {
    lines.push(`- (${r.type}) ${safeUrl(r.url)}`);
  }
  if (blocking.length > 20) lines.push(`- … and ${blocking.length - 20} more`);
  const evidence: InsightDetails['evidence'] = blocking.slice(0, 20).map((r) => ({
    kind: 'request' as const,
    ref: safeUrl(r.url),
  }));
  return {
    summary,
    details: { insight: 'RenderBlocking', details_md: lines.join('\n'), evidence },
  };
};

/* ──────────────────────────────────────────────────────────────────── */
/* CLSCulprits                                                          */
/* ──────────────────────────────────────────────────────────────────── */

const clsCulprits: EvaluatorFn = (trace) => {
  // Layout-shift events arrive as `LayoutShift` with `args.data.score`.
  const shifts = eventsByName(trace.traceEvents, 'LayoutShift');
  if (shifts.length === 0) return null;
  let cls = 0;
  const culprits: { score: number; ts: number }[] = [];
  for (const ev of shifts) {
    const data = ((ev.args ?? {}) as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    const score =
      data && typeof data.score === 'number' ? (data.score as number) :
      data && typeof data.weighted_score_delta === 'number' ? (data.weighted_score_delta as number) :
      0;
    cls += score;
    culprits.push({ score, ts: typeof ev.ts === 'number' ? ev.ts : 0 });
  }
  const clsRounded = Math.round(cls * 1000) / 1000;
  const severity = clsRounded >= 0.25 ? 'critical' : clsRounded >= 0.1 ? 'warn' : 'info';
  const summary: InsightSummary = {
    name: 'CLSCulprits',
    severity,
    one_line: `CLS ${clsRounded.toFixed(3)} from ${culprits.length} shift${culprits.length === 1 ? '' : 's'}`,
  };
  culprits.sort((a, b) => b.score - a.score);
  const top = culprits.slice(0, 5);
  const lines = [
    `# CLSCulprits`,
    ``,
    `**Total CLS**: ${clsRounded.toFixed(3)} (${severity})`,
    `**Shift count**: ${culprits.length}`,
    ``,
    `## Top contributors`,
    ``,
  ];
  for (const c of top) {
    lines.push(`- score=${c.score.toFixed(3)} at ${fmtMs(usToMs(c.ts))}`);
  }
  const evidence: InsightDetails['evidence'] = [
    { kind: 'metric', ref: `CLS=${clsRounded.toFixed(3)}` },
    ...top.map((c) => ({
      kind: 'event' as const,
      ref: `LayoutShift score=${c.score.toFixed(3)}@${fmtMs(usToMs(c.ts))}`,
    })),
  ];
  return {
    summary,
    details: { insight: 'CLSCulprits', details_md: lines.join('\n'), evidence },
  };
};

/* ──────────────────────────────────────────────────────────────────── */
/* LongTasks                                                            */
/* ──────────────────────────────────────────────────────────────────── */

const longTasks: EvaluatorFn = (trace) => {
  // Main-thread "RunTask" events with dur > 50000 us (50 ms) are the
  // PerformanceObserver definition of a long task.
  const tasks = eventsByName(trace.traceEvents, 'RunTask').concat(
    eventsByName(trace.traceEvents, 'Task'),
  );
  const long = tasks
    .filter((e) => typeof e.dur === 'number' && (e.dur as number) >= 50_000)
    .sort((a, b) => (b.dur as number) - (a.dur as number));
  if (long.length === 0) {
    return {
      summary: {
        name: 'LongTasks',
        severity: 'info',
        one_line: 'no long tasks (>50ms) detected',
      },
      details: {
        insight: 'LongTasks',
        details_md: `# LongTasks\n\nNo long tasks (>50ms) detected in this trace.`,
        evidence: [],
      },
    };
  }
  const totalBlockingMs = long.reduce(
    (acc, t) => acc + Math.max(0, usToMs((t.dur as number) - 50_000)),
    0,
  );
  const severity = totalBlockingMs >= 600 ? 'critical' : totalBlockingMs >= 200 ? 'warn' : 'info';
  const summary: InsightSummary = {
    name: 'LongTasks',
    severity,
    one_line: `${long.length} long task${long.length === 1 ? '' : 's'}, ~${fmtMs(totalBlockingMs)} blocking`,
  };
  const lines = [
    `# LongTasks`,
    ``,
    `**Long tasks**: ${long.length}`,
    `**Total blocking time**: ${fmtMs(totalBlockingMs)} (${severity})`,
    ``,
    `## Top tasks`,
    ``,
  ];
  for (const t of long.slice(0, 5)) {
    lines.push(`- ${fmtMs(usToMs(t.dur as number))} at ${fmtMs(usToMs(t.ts ?? 0))}`);
  }
  const evidence: InsightDetails['evidence'] = [
    { kind: 'metric', ref: `TBT=${fmtMs(totalBlockingMs)}` },
    ...long.slice(0, 5).map((t) => ({
      kind: 'event' as const,
      ref: `LongTask dur=${fmtMs(usToMs(t.dur as number))}@${fmtMs(usToMs(t.ts ?? 0))}`,
    })),
  ];
  return {
    summary,
    details: { insight: 'LongTasks', details_md: lines.join('\n'), evidence },
  };
};

/* ──────────────────────────────────────────────────────────────────── */
/* ThirdParties                                                         */
/* ──────────────────────────────────────────────────────────────────── */

const thirdParties: EvaluatorFn = (trace) => {
  const sends = eventsByName(trace.traceEvents, 'ResourceSendRequest');
  if (sends.length === 0) return null;
  // Determine first-party host from the first Document request, fall
  // back to the most-frequently-seen host if the document isn't tagged.
  let firstPartyHost: string | undefined;
  for (const ev of sends) {
    const data = ((ev.args ?? {}) as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    if (data && data.resourceType === 'Document' && typeof data.url === 'string') {
      firstPartyHost = hostnameOf(data.url);
      break;
    }
  }
  // Tally bytes per host. CDP supplies `encodedDataLength` on
  // `ResourceFinish`, but for portability we first count requests; then
  // augment with bytes when present.
  const byHost = new Map<string, { count: number; bytes: number }>();
  const finishMap = new Map<string, number>();
  for (const ev of eventsByName(trace.traceEvents, 'ResourceFinish')) {
    const data = ((ev.args ?? {}) as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    if (!data) continue;
    const rid = typeof data.requestId === 'string' ? data.requestId : undefined;
    const bytes = typeof data.encodedDataLength === 'number' ? (data.encodedDataLength as number) : 0;
    if (rid) finishMap.set(rid, bytes);
  }
  for (const ev of sends) {
    const data = ((ev.args ?? {}) as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    if (!data || typeof data.url !== 'string') continue;
    const host = hostnameOf(data.url);
    if (!host) continue;
    const rid = typeof data.requestId === 'string' ? data.requestId : '';
    const bytes = finishMap.get(rid) ?? 0;
    const cur = byHost.get(host) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += bytes;
    byHost.set(host, cur);
  }
  if (!firstPartyHost) {
    let max = 0;
    for (const [h, v] of byHost.entries()) {
      if (v.count > max) {
        max = v.count;
        firstPartyHost = h;
      }
    }
  }
  const thirdPartyEntries = Array.from(byHost.entries())
    .filter(([h]) => h !== firstPartyHost)
    .sort((a, b) => b[1].count - a[1].count);
  if (thirdPartyEntries.length === 0) {
    return {
      summary: {
        name: 'ThirdParties',
        severity: 'info',
        one_line: 'no third-party origins detected',
      },
      details: {
        insight: 'ThirdParties',
        details_md: `# ThirdParties\n\nAll resources were served from the first-party host${firstPartyHost ? ` \`${firstPartyHost}\`` : ''}.`,
        evidence: [],
      },
    };
  }
  const totalRequests = thirdPartyEntries.reduce((a, [, v]) => a + v.count, 0);
  const severity = thirdPartyEntries.length >= 10 ? 'warn' : 'info';
  const summary: InsightSummary = {
    name: 'ThirdParties',
    severity,
    one_line: `${thirdPartyEntries.length} third-party origin${thirdPartyEntries.length === 1 ? '' : 's'}, ${totalRequests} request${totalRequests === 1 ? '' : 's'}`,
  };
  const lines = [
    `# ThirdParties`,
    ``,
    `**First-party host**: \`${firstPartyHost ?? 'unknown'}\``,
    `**Third-party origins**: ${thirdPartyEntries.length}`,
    `**Third-party requests**: ${totalRequests}`,
    ``,
    `## Top origins`,
    ``,
  ];
  for (const [host, v] of thirdPartyEntries.slice(0, 10)) {
    const bytesPart = v.bytes > 0 ? `, ${(v.bytes / 1024).toFixed(1)} KB` : '';
    lines.push(`- \`${host}\` — ${v.count} request${v.count === 1 ? '' : 's'}${bytesPart}`);
  }
  const evidence: InsightDetails['evidence'] = thirdPartyEntries.slice(0, 10).map(([host, v]) => ({
    kind: 'request' as const,
    ref: `${host} (${v.count})`,
  }));
  return {
    summary,
    details: { insight: 'ThirdParties', details_md: lines.join('\n'), evidence },
  };
};

/* ──────────────────────────────────────────────────────────────────── */
/* Engine entry points                                                  */
/* ──────────────────────────────────────────────────────────────────── */

export const EVALUATORS: Record<InsightName, EvaluatorFn> = {
  LCPBreakdown: lcpBreakdown,
  DocumentLatency: documentLatency,
  RenderBlocking: renderBlocking,
  CLSCulprits: clsCulprits,
  LongTasks: longTasks,
  ThirdParties: thirdParties,
};
