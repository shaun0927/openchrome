# OpenChrome Benchmark Suite

> **Note on history:** This directory is the legacy Twitter/X scraping benchmark. The competitive benchmark suite ([Epic #1254](https://github.com/shaun0927/openchrome/issues/1254)) replaces it with a per-axis structure under `tests/benchmark/`, exposed via the `bench:*` npm scripts at the repo root:
>
> - `npm run bench:tokens` — Token Efficiency axis (#1256)
> - `npm run bench:throughput` — Speed & Throughput axis (#1258)
> - `npm run bench:latency` — single-action latency (#1258)
>
> The scripts below remain functional for the legacy Twitter/X scenario (real Playwright measurements, no estimation). New axes should land in `tests/benchmark/` instead of here.

Real-world benchmark comparing OpenChrome vs Playwright for Twitter/X profile scraping.

## Task

Crawl latest tweets from 20 Twitter/X celebrities using the same Chrome instance (CDP port 9222) with identical auth state.

## Prerequisites

- Chrome running with `--remote-debugging-port=9222`
- Logged into Twitter/X
- Node.js 18+

## Setup

```bash
cd benchmark
npm install
```

## Running Benchmarks

Each benchmark must be run **in isolation** (one at a time, no other browser automation running):

```bash
# Playwright sequential baseline
npm run playwright

# OpenChrome sequential (1 tab at a time)
npm run oc:seq

# OpenChrome parallel strategies
npm run oc:batch5     # Batches of 5 tabs
npm run oc:batch10    # Batches of 10 tabs (fastest)
npm run oc:batch20    # All 20 tabs at once

# Generate charts and report from results
npm run svg
npm run report

# Run everything sequentially
npm run all
```

## Files

| File | Description |
|------|-------------|
| `config.mjs` | Shared config: 20 target accounts, CDP endpoint |
| `playwright-benchmark.mjs` | Playwright sequential benchmark |
| `parallel-isolated.mjs` | OpenChrome parallel benchmark (CLI batch size) |
| `generate-svg.mjs` | SVG chart generator (speed, tokens, dashboard) |
| `generate-report.mjs` | Markdown report generator |

## Results

Results are saved to `results/`:

| File | Description |
|------|-------------|
| `playwright-results.json` | Playwright sequential measurements |
| `isolated-batch1.json` | OC sequential measurements |
| `isolated-batch5.json` | OC 5-tab batch measurements |
| `isolated-batch10.json` | OC 10-tab batch measurements |
| `isolated-batch20.json` | OC 20-tab batch measurements |
| `chart-speed.svg` | Speed comparison chart |
| `chart-tokens.svg` | Token efficiency chart |
| `chart-dashboard.svg` | Combined dashboard |
| `BENCHMARK-REPORT.md` | Full markdown report |

## Key Results

| Strategy | Time | Speedup | Success |
|----------|------|---------|---------|
| PW Sequential | 82.3s | baseline | 95% |
| OC Sequential | 82.4s | 1.0x | 95% |
| OC 5-batch | 28.7s | 2.9x | 95% |
| **OC 10-batch** | **23.2s** | **3.5x** | **95%** |
| OC 20-batch | 25.7s | 3.2x | 95% |

Token efficiency: see [`TOKEN-EFFICIENCY-REPORT.md`](./results/TOKEN-EFFICIENCY-REPORT.md) — produced by `npm run bench:tokens` and a per-archetype compression measurement over a 50-fixture corpus, replacing the retired hard-coded estimate.

## Methodology

- Same Chrome v145 instance via CDP for both tools
- Same logged-in session (real Chrome profile)
- Each strategy run in a completely separate process
- Token compression: real per-archetype measurement (#1256); legacy hard-coded estimate retired
