/**
 * Synthetic trace fixtures for the v1 performance-insights engine (#846).
 *
 * These are intentionally minimal — just enough event shapes that each
 * evaluator either has data to chew on or returns a no-data placeholder.
 * Real traces are megabytes; the engine's contract is "small evaluator
 * surface, robust to missing fields", which we exercise here.
 */

import type { TraceDocument } from '../../../../src/core/performance/insights/types';

/** A trace that contains examples for every insight. */
export function richTrace(): TraceDocument {
  return {
    traceEvents: [
      // Navigation start — anchor for trace-relative timestamps.
      // Subtracted from each event's `ts` to derive elapsed-since-nav.
      {
        name: 'navigationStart',
        cat: 'blink.user_timing',
        ph: 'I',
        ts: 0,
      },
      // Document request — first ResourceSendRequest with resourceType=Document.
      {
        name: 'ResourceSendRequest',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 1_000_000,
        args: {
          data: {
            requestId: 'req-doc-1',
            url: 'https://example.com/',
            resourceType: 'Document',
            requestPriority: 'VeryHigh',
          },
        },
      },
      // Document response — 800 ms TTFB (warn).
      {
        name: 'ResourceReceiveResponse',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 1_800_000,
        args: { data: { requestId: 'req-doc-1' } },
      },
      // Render-blocking CSS.
      {
        name: 'ResourceSendRequest',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 1_900_000,
        args: {
          data: {
            requestId: 'req-css-1',
            url: 'https://example.com/styles.css?v=token=abc12345secretvalue',
            resourceType: 'Stylesheet',
            renderBlocking: 'blocking',
          },
        },
      },
      {
        name: 'ResourceFinish',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 2_000_000,
        args: { data: { requestId: 'req-css-1', encodedDataLength: 12_345 } },
      },
      // Third-party script (different host).
      {
        name: 'ResourceSendRequest',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 2_100_000,
        args: {
          data: {
            requestId: 'req-3p-1',
            url: 'https://cdn.thirdparty.example/lib.js',
            resourceType: 'Script',
          },
        },
      },
      {
        name: 'ResourceFinish',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 2_200_000,
        args: { data: { requestId: 'req-3p-1', encodedDataLength: 50_000 } },
      },
      // LCP candidates — last one wins.
      {
        name: 'largestContentfulPaint::Candidate',
        cat: 'loading',
        ph: 'I',
        ts: 2_300_000,
        args: { data: { size: 5000, nodeName: 'IMG' } },
      },
      {
        name: 'largestContentfulPaint::Candidate',
        cat: 'loading',
        ph: 'I',
        ts: 3_200_000, // 3.2s LCP — warn
        args: {
          data: {
            size: 9000,
            url: 'https://example.com/hero.jpg',
            nodeName: 'IMG',
          },
        },
      },
      // Layout shifts.
      {
        name: 'LayoutShift',
        cat: 'loading',
        ph: 'I',
        ts: 2_400_000,
        args: { data: { score: 0.05 } },
      },
      {
        name: 'LayoutShift',
        cat: 'loading',
        ph: 'I',
        ts: 2_700_000,
        args: { data: { score: 0.12 } }, // Total 0.17 = warn
      },
      // Long task.
      {
        name: 'RunTask',
        cat: 'devtools.timeline',
        ph: 'X',
        ts: 2_500_000,
        dur: 250_000, // 250ms
      },
      {
        name: 'RunTask',
        cat: 'devtools.timeline',
        ph: 'X',
        ts: 2_800_000,
        dur: 60_000, // 60ms
      },
    ],
  };
}

/** Trace with no events — every evaluator should yield no-data. */
export function emptyTrace(): TraceDocument {
  return { traceEvents: [] };
}

/** Trace where LCP is well under 2.5s — should be `info`. */
export function fastTrace(): TraceDocument {
  return {
    traceEvents: [
      {
        name: 'navigationStart',
        cat: 'blink.user_timing',
        ph: 'I',
        ts: 0,
      },
      {
        name: 'largestContentfulPaint::Candidate',
        cat: 'loading',
        ph: 'I',
        ts: 1_800_000, // 1.8s LCP
        args: { data: { size: 4000, nodeName: 'H1' } },
      },
      {
        name: 'ResourceSendRequest',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 100_000,
        args: {
          data: {
            requestId: 'r1',
            url: 'https://fast.example/',
            resourceType: 'Document',
          },
        },
      },
      {
        name: 'ResourceReceiveResponse',
        cat: 'devtools.timeline',
        ph: 'I',
        ts: 250_000, // 150ms TTFB
        args: { data: { requestId: 'r1' } },
      },
    ],
  };
}
