# Benchmark headline evidence gates

This document is the promotion contract for the benchmark issues grouped under
#1254, #1255, #1256, #1258, #1260, #1261, and #1310. Rows that do not satisfy
these gates are diagnostic/smoke evidence only and must not be used for headline
claims.

## Global promotion gate

A row is headline-eligible only when all fields below are present in the result
artifact:

- `evidence_tier`: `live` or `recorded-real`.
- `runner_command`: exact command used to produce the row.
- `measured_at`: ISO timestamp.
- `host`: OS, CPU architecture, Node version, Chrome version when browser-based.
- `subject.version`: OpenChrome or competitor version/commit.
- `task.id` and fixture version.
- `repetitions.n >= 3` unless the row is explicitly marked `single-smoke`.
- `raw_artifacts`: paths to JSON/PNG/log records sufficient to reproduce the row.
- `promotion_decision`: `headline_eligible` with reviewer/date, otherwise the row
  remains `diagnostic_only`.

## Issue-specific gates

| Issues | Required evidence before closing |
| --- | --- |
| #1254, #1310 | Full matrix report where every headline row passes the global promotion gate; stale OpenChrome artifacts removed or marked superseded. |
| #1255 | Live smoke for OpenChrome, Playwright, Puppeteer, playwright-mcp, browser-use, and Crawlee with pinned versions. Skipped competitors require machine-readable skip reasons. |
| #1256 | Live/recorded-real extractor rows for OpenChrome `read_page`/AX, Playwright accessibility, playwright-mcp, and browser-use. |
| #1258 | Live Chrome/CDP throughput rows for OpenChrome, Playwright, and Puppeteer, with cold and reuse modes reported separately. |
| #1260 | Local auth fixture stays diagnostic; third-party auth rows require operator-owned credentials and redacted evidence records. |
| #1261 | `tools/list` introspection fixtures for all MCP competitors being compared; framework rows explicitly marked non-applicable. |

## Required reviewer action

Before any benchmark PR changes `Benchmark readiness` from `NOT READY`, reviewers
must run:

```bash
npm run bench:runtime-preflight
npm run bench:competitor-smoke
npm run bench:readiness
```

Then inspect the generated artifacts and update `benchmark/results/BENCHMARK-READINESS.md` with the actual result. Do not hand-edit a ready verdict.
