# OpenChrome Competitive Benchmark Report

Generated: 2026-05-16T02:17:47.951Z
Source: per-axis section files under `benchmark/results/`.

Part of [Epic #1254](https://github.com/shaun0927/openchrome/issues/1254) — the competitive benchmark suite. Each section below is generated from its axis runner's envelope; this top-level file is the union.

## Headline status

| Section | Axis | Issue | Evidence role | State |
| --- | --- | --- | --- | --- |
| #G | Complex Real-World Task Completion | [#1305](https://github.com/shaun0927/openchrome/issues/1305) | primary | measured |
| #B | Agent Task Success | [#1257](https://github.com/shaun0927/openchrome/issues/1257) | primary-when-live-or-recorded-real | pending |
| #D | Reliability & Fault-Recovery | [#1259](https://github.com/shaun0927/openchrome/issues/1259) | primary-when-episode-stress | pending |
| #E | Auth & Real-World Usability | [#1260](https://github.com/shaun0927/openchrome/issues/1260) | primary-when-episode | pending |
| #A | Token Efficiency | [#1256](https://github.com/shaun0927/openchrome/issues/1256) | diagnostic | measured |
| #C | Speed & Throughput | [#1258](https://github.com/shaun0927/openchrome/issues/1258) | diagnostic | measured |
| #F | Developer Experience | [#1261](https://github.com/shaun0927/openchrome/issues/1261) | diagnostic | measured |

## Primary evidence policy

Complex real-world episode completion is the primary benchmark evidence. Token, speed, auth setup, reliability micro-cells, and DX axes are supporting diagnostics unless they are attached to a final task-completion episode with headline-eligible live or recorded-real rows. See `docs/benchmarks/benchmark-direction.md`.

Mock, scaffold, dry-run, and skip rows are never reported as competitive wins; they are harness regression evidence only. A row must evaluate the final task postcondition, pin versions/environment, and meet the sample threshold before it can be headline-eligible.

## Methodology principles
All sections honor Epic #1254's ten methodology principles:
1. N ≥ 5 repetitions; p50/p95/stddev + bootstrap 95% CI
2. Version pinning per `benchmark/COMPETITORS.md`
3. Environment metadata embedded in every result envelope
4. Adapter pattern — same task code across every library
5. Identical conditions (same Chrome instance, same LLM)
6. Fixed datasets (local fixtures over live sites where the metric allows)
7. Losing scenarios published honestly
8. LLM pin exactly frozen per run
9. Reproducibility — fixtures, ground-truth, scripts, rubrics all committed
10. Sample sizes justified per axis, not conventional

## Retired estimates
Two legacy headline numbers were retired by Epic #1254: an unverified token-compression ratio and a similarly unverified speedup claim. Both came from estimates averaging only two real measurements. The Epic-close generator (`benchmark/generate-benchmark-report.mjs`) lints for those exact literals and fails the build if they reappear — see `RETIRED_CLAIMS` in that file for the precise list.

## #G Complex Real-World Task Completion (#1305)

Generated: 2026-05-15T23:53:20.745Z
Source: `benchmark/results/realworld-task-completion.json` (axis: `realworld-task-completion`).

## Claim scope

- Measurement mode: `deterministic-fixture`
- Claim scope: **scaffold-only; not a live competitive measurement**
- This report is the scaffold/local-fixture baseline for the real-world task-completion axis. It is **not** a live competitive win claim.
- #1261 remains the DX/supporting axis; this section is the primary task-completion axis.

## Metrics by library

| Library | Mode | Runs | Success | First-attempt success | Recovery success | Mean tool calls | Mean wall time ms | p95 wall time ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `openchrome` | `deterministic-fixture` | 5 | 100.0% | 80.0% | 100.0% | 9.6 | 1640 | 2175 |

## Task corpus

| Task | Tier | Max steps | Recovery? | Complexity tags |
| --- | --- | ---: | --- | --- |
| `rw-001-checkout-update-address` Update a checkout shipping address and verify recalculated summary | local-fixture | 14 | no | form-fill, stateful-ui, verification |
| `rw-002-search-filter-compare` Search, filter, compare two products, and extract the cheaper eligible item | local-fixture | 16 | no | search, filtering, extraction, decision |
| `rw-003-tab-research-synthesis` Use multiple tabs to synthesize two reference pages into one answer | stable-public-reference | 18 | no | tabs, reading, synthesis |
| `rw-004-selector-drift-recovery` Recover from selector drift while submitting a feedback form | recovery | 20 | yes | fault-recovery, form-fill, grounding |
| `rw-005-long-horizon-itinerary` Build and verify a multi-step itinerary from constrained options | long-horizon | 28 | no | long-horizon, filtering, decision, stateful-ui |

## Next measurement work

- Add live OpenChrome / playwright-mcp / Puppeteer MCP / browsermcp adapter rows only after real execution.
- Pin competitor and LLM versions before publishing live comparisons.
- Keep local deterministic fixture rows separate from live-web rows.


## #B Agent Task Success (#1257)

*No data yet for #1257. Run the axis runner + `agent-success` generator to populate.*

## #D Reliability & Fault-Recovery (#1259)

*Section file pending — axis #1259 infrastructure is in place but its dedicated section generator has not yet landed. See the per-axis runner output in `benchmark/results/` for the current envelope.*

## #E Auth & Real-World Usability (#1260)

*Section file pending — axis #1260 infrastructure is in place but its dedicated section generator has not yet landed. See the per-axis runner output in `benchmark/results/` for the current envelope.*

## #A Token Efficiency (#1256)

Generated: 2026-05-15T06:08:01.226Z
Source: `benchmark/results/token-efficiency.json` (axis: `token-efficiency`, schema 1.0.0).
Tokenizer: `cl100k_base`.

## Methodology
- Each `(library × fixture)` cell records median payload tokens, retention rate, and compression ratio over N samples.
- Retention is scored against the ≥ 12-field ground-truth per fixture per `RUBRIC.md`. A raw HTML dump does NOT score retention by substring match — only structured field-keyed extraction counts.
- Live-only cells (real Chrome / Python) are explicitly annotated when skipped in `--skip-live` mode; they are never plotted as 0 or omitted silently.

## Per-library × per-archetype median tokens
Lower is better. "(skip)" = library not measured in this run.

| Library | docs | ecommerce | news | search-results | spa |
| --- | ---: | ---: | ---: | ---: | ---: |
| `browser-use-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `crawlee-cheerio` | 2691 | 3571 | 4768 | 3314 | 4863 |
| `deterministic-static` | 88 | 78 | 96 | 157 | 96 |
| `openchrome-readpage-ax` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `openchrome-readpage-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-a11y` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-content` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-innertext` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-mcp-snapshot` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |

## Per-library × per-archetype median retention
Higher is better. "(skip)" = library not measured in this run.

| Library | docs | ecommerce | news | search-results | spa |
| --- | ---: | ---: | ---: | ---: | ---: |
| `browser-use-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `crawlee-cheerio` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `deterministic-static` | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| `openchrome-readpage-ax` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `openchrome-readpage-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-a11y` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-content` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-innertext` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-mcp-snapshot` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |

## Per-library × per-archetype median compression
Higher is better (× vs raw HTML tokens).

| Library | docs | ecommerce | news | search-results | spa |
| --- | ---: | ---: | ---: | ---: | ---: |
| `browser-use-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `crawlee-cheerio` | 2.4× | 2.4× | 2.4× | 2.4× | 2.3× |
| `deterministic-static` | 73.9× | 109.1× | 116.8× | 51.1× | 116.8× |
| `openchrome-readpage-ax` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `openchrome-readpage-dom` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-a11y` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-content` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-innertext` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |
| `playwright-mcp-snapshot` | *(skip)* | *(skip)* | *(skip)* | *(skip)* | *(skip)* |

## Per-archetype upper-left winner
Lowest tokens at the max retention measured in this run.

| Archetype | Winner library | Retention |
| --- | --- | ---: |
| docs | `deterministic-static` | 100.0% |
| ecommerce | `deterministic-static` | 100.0% |
| news | `deterministic-static` | 100.0% |
| search-results | `deterministic-static` | 100.0% |
| spa | `deterministic-static` | 100.0% |

## Cells skipped in this run
350 cells did not run because they are live-only and `OPENCHROME_BENCH_LIVE=1` was not set.

Skipped libraries:
- `browser-use-dom`
- `openchrome-readpage-ax`
- `openchrome-readpage-dom`
- `playwright-a11y`
- `playwright-content`
- `playwright-innertext`
- `playwright-mcp-snapshot`

To run them, set `OPENCHROME_BENCH_LIVE=1` and re-run `npm run bench:tokens`. Today the live cells are scaffolded but not yet wired to their real Chrome / Python integrations — that is queued for the next session.

## Headline
Across 5 archetypes with measured cells, **`deterministic-static`** sits in the upper-left of the scatter on 5 / 5.

See `chart-tokens-scatter.svg` for the per-archetype scatter view.


## #C Speed & Throughput (#1258)

Generated: 2026-05-15T06:11:26.078Z
Source: `benchmark/results/speed-throughput.json` (axis: `speed-throughput`, schema 1.0.0).
Environment: Node v20.19.6 on darwin 25.3.0 arm64 (Apple M5, 10 cores).

## Methodology
- Pages served by the local static fixture server (50-page mirror, `/page/N` routes). Zero network variance, byte-identical input per request.
- Warm-up iterations discarded before timing (default 3); the discard count is recorded per cell.
- Per [issue #1258](https://github.com/shaun0927/openchrome/issues/1258): **raw throughput and success rate are reported as two PRIMARY columns**, with effective throughput shown only as a **SECONDARY composite** (raw × success). Collapsing those two primaries into one number is what made the old "20 tabs = 18.9s but 10% success" headline misleading.

## Throughput — primary columns (raw + success), secondary composite (effective)

| Library | Mode | Concurrency | Raw pg/s (PRIMARY) | Success (PRIMARY) | Effective pg/s (secondary) | p50 wall (ms) | p95 wall (ms) | Samples kept | Warm-up discarded |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `OpenChrome` | `dom-stub` | 1 | 50000.0 | 100.0% | 50000.0 | 1.0 | 1.0 | 1 | 3 |
| `OpenChrome` | `dom-stub` | 5 | 0.0 | 100.0% | 0.0 | 0.0 | 0.0 | 1 | 3 |
| `OpenChrome` | `dom-stub` | 10 | 0.0 | 100.0% | 0.0 | 0.0 | 0.0 | 1 | 3 |
| `OpenChrome` | `dom-stub` | 20 | 0.0 | 100.0% | 0.0 | 0.0 | 0.0 | 1 | 3 |

## Single-action latency (#1258)
No latency results available. Run `npm run bench:latency -- --ci` to produce `benchmark/results/speed-latency.json`, then re-run this generator.

## Session reuse delta
Issue #1258 calls for a 100-task fresh-vs-reused-session delta. That measurement requires a live Chrome instance to exercise the OpenChromeRealAdapter setup/teardown lifecycle, so it ships in the next-session follow-up alongside the live-mode throughput cells. The runner skeleton (`run-throughput.ts`) already plumbs `OPENCHROME_BENCH_LIVE=1` so the next commit only needs to add a `--session-reuse` mode without touching the result envelope shape.

## Headline
Measured 4 cells across libraries: `OpenChrome`; concurrencies: 1 / 5 / 10 / 20.

Only one library produced numbers in this run (`OpenChrome`). Competitor cells (Playwright, Puppeteer, Crawlee) plug into the same runner via the existing adapter registry; the next-session follow-up wires them through `buildAdapter()`.

See `chart-throughput.svg` and `chart-success-rate.svg` for the visual companions.


## #F Developer Experience (#1261)

Generated: 2026-05-15T09:23:53.402Z
Source: `benchmark/results/dx.json` (axis: `developer-experience`).

## Rule of two charts
Issue #1261 forbids a single composite radar — LOC trivially favors MCP servers, schema metrics are N/A for non-MCP libraries. The DX section therefore splits into:
- **MCP DX** (this chart): libraries that ship an MCP server, scored across all rubrics
- **Framework DX** (next chart): all libraries including raw frameworks, **LOC only** (the only metric every library participates in)

## MCP DX
| Library | form-fill | navigate-and-read | Schema completeness | Error actionability |
| --- | ---: | ---: | ---: | ---: |
| `openchrome` | 10 | 7 | *pending* | *pending* |

See `chart-dx-mcp.svg` for the visual companion.

## Framework DX
LOC per task. Composites computed only over axes where every library participates — here that's LOC alone.

| Library | form-fill | navigate-and-read | median LOC |
| --- | ---: | ---: | ---: |
| `openchrome` | 10 | 7 | 8.5 |
| `playwright` | 12 | 10 | 11 |
| `puppeteer` | 16 | 10 | 13 |

See `chart-dx-framework.svg` for the visual companion.

## Pending rubrics
- Schema completeness: requires MCP `tools/list` introspection per library (issue #1261 mentions `lint:tool-schemas` as the OpenChrome side). Lands in the next-session follow-up.
- Error actionability: requires running induced failures through each library and scoring the returned errors against the rubric in `dx-rubrics.ts`. Same follow-up.

## Headline
Framework DX LOC winner (lower is better): **`openchrome`** at median 8.5 LOC.
