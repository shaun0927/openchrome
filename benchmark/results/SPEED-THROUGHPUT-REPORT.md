# Speed & Throughput (#1258) — competitive report

Generated: 2026-05-16T03:34:40.153Z
Source: `benchmark/results/speed-throughput.json` (axis: `speed-throughput`, schema 1.0.0).
Environment: Node v20.19.6 on darwin 25.3.0 arm64 (Apple M5, 10 cores).

## Methodology
- Pages served by the local static fixture server (50-page mirror, `/page/N` routes). Zero network variance, byte-identical input per request.
- Warm-up iterations discarded before timing (default 3); the discard count is recorded per cell.
- Per [issue #1258](https://github.com/shaun0927/openchrome/issues/1258): **raw throughput and success rate are reported as two PRIMARY columns**, with effective throughput shown only as a **SECONDARY composite** (raw × success). Collapsing those two primaries into one number is what made the old "20 tabs = 18.9s but 10% success" headline misleading.

## Throughput — primary columns (raw + success), secondary composite (effective)

| Library | Mode | Concurrency | Raw pg/s (PRIMARY) | Success (PRIMARY) | Effective pg/s (secondary) | p50 wall (ms) | p95 wall (ms) | Samples kept | Warm-up discarded |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `OpenChrome` | `dom-stub` | 1 | 0.0 | 100.0% | 0.0 | 0.0 | 0.0 | 1 | 3 |
| `Crawlee` | `cheerio-text` | 1 | 135.1 | 100.0% | 135.1 | 370.0 | 370.0 | 1 | 3 |

## Single-action latency (#1258)
No latency results available. Run `npm run bench:latency -- --ci` to produce `benchmark/results/speed-latency.json`, then re-run this generator.

## Session reuse delta
Issue #1258 calls for a 100-task fresh-vs-reused-session delta. That measurement requires a live Chrome instance to exercise the OpenChromeRealAdapter setup/teardown lifecycle, so it ships in the next-session follow-up alongside the live-mode throughput cells. The runner skeleton (`run-throughput.ts`) already plumbs `OPENCHROME_BENCH_LIVE=1` so the next commit only needs to add a `--session-reuse` mode without touching the result envelope shape.

## Headline
Measured 2 cells across libraries: `Crawlee`, `OpenChrome`; concurrencies: 1.

See `chart-throughput.svg` and `chart-success-rate.svg` for the visual companions.
