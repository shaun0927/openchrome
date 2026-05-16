# Open benchmark issue readiness audit

Generated: 2026-05-16T03:34:40.041Z

## Verdict

**NOT READY:** open benchmark issues are not fully implemented, and the current repo cannot measure every benchmark axis as publishable/headline evidence.

| Metric | Count |
| --- | ---: |
| Open benchmark issues audited | 16 |
| Ready | 0 |
| Partial | 11 |
| Not ready | 5 |
| Headline-measurement-ready | 0 |
| Diagnostic/smoke only | 11 |
| Not measurable yet | 5 |

## Issue matrix

| Issue | Status | Measurement readiness | Primary blocker |
| --- | --- | --- | --- |
| [#1254](https://github.com/shaun0927/openchrome/issues/1254) Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source | not_ready | not_measurable | Multiple child axes remain partial or scaffolded; unified report still marks several sections pending. |
| [#1255](https://github.com/shaun0927/openchrome/issues/1255) Benchmark #0: Harness Foundation — competitor adapters, exact tokenizer, env metadata | partial | diagnostic_or_smoke_only | The suite is not yet proven with every live competitor adapter passing the same smoke task and pinned versions. |
| [#1256](https://github.com/shaun0927/openchrome/issues/1256) Benchmark #A: Token Efficiency — payload tokens vs information retention | partial | diagnostic_or_smoke_only | OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractors still require live/recorded-real wiring before headline token-efficiency claims. |
| [#1257](https://github.com/shaun0927/openchrome/issues/1257) Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget | partial | diagnostic_or_smoke_only | Live Claude/WebVoyager and competitor-native loops remain unwired, so current rows are controlled mock evidence only. |
| [#1258](https://github.com/shaun0927/openchrome/issues/1258) Benchmark #C: Speed & Throughput — effective (success-weighted) throughput | partial | diagnostic_or_smoke_only | Playwright/Puppeteer throughput cells require a live Chrome/CDP endpoint; session-reuse delta is still missing; headline competitor matrix needs operator-run live evidence. |
| [#1259](https://github.com/shaun0927/openchrome/issues/1259) Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie | partial | diagnostic_or_smoke_only | Live fault-injection proxy/CDP cells, Chrome RSS/zombie sampling, and task-completion stress matrix remain unwired. |
| [#1260](https://github.com/shaun0927/openchrome/issues/1260) Benchmark #E: Auth & Real-World Usability — logged-in success + setup cost | partial | diagnostic_or_smoke_only | Wall-clock setup time and logged-in smoke success are null/pending in the current runner. |
| [#1261](https://github.com/shaun0927/openchrome/issues/1261) Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability | partial | diagnostic_or_smoke_only | Schema completeness and error actionability are emitted as null pending MCP introspection/failure induction. |
| [#1299](https://github.com/shaun0927/openchrome/issues/1299) Benchmark: Episode-level token cost to completion | partial | diagnostic_or_smoke_only | Rows are controlled mock/local evidence; live LLM token/USD accounting and competitor-native task cost are not wired. |
| [#1300](https://github.com/shaun0927/openchrome/issues/1300) Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite | partial | diagnostic_or_smoke_only | The suite is still a controlled foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy. |
| [#1301](https://github.com/shaun0927/openchrome/issues/1301) Benchmark #B follow-up: real LLM repetitions and full-task metrics gate | not_ready | not_measurable | Real Anthropic Messages loop throws intentionally; `--repetitions` is not expanded into repeated samples; full-task token/USD accounting is missing. |
| [#1302](https://github.com/shaun0927/openchrome/issues/1302) Benchmark #B follow-up: native/passive competitor adapter matrix | not_ready | not_measurable | playwright-mcp and browser-use native loops are marked `nativeLoopWired: false`. |
| [#1303](https://github.com/shaun0927/openchrome/issues/1303) Benchmark #D follow-up: inject reliability faults inside real-world tasks | not_ready | not_measurable | Faults are not injected inside real-world task episodes and recovery is not judged by final task postconditions. |
| [#1304](https://github.com/shaun0927/openchrome/issues/1304) Benchmark #D follow-up: real-world task completion as primary reliability signal | not_ready | not_measurable | No library × task × repetition matrix uses real-world task completion as the primary reliability metric. |
| [#1305](https://github.com/shaun0927/openchrome/issues/1305) Benchmark #G: Complex Real-World Task Completion | partial | diagnostic_or_smoke_only | Current rows are deterministic scaffold/local-fixture evidence, not live competitive task-completion measurements. |
| [#1310](https://github.com/shaun0927/openchrome/issues/1310) Benchmark: enforce headline eligibility for real-world episode claims | partial | diagnostic_or_smoke_only | Eligibility is not yet enforced across every real-world/live report path and cannot promote any row without live or recorded-real evidence. |

## Details

### [#1254](https://github.com/shaun0927/openchrome/issues/1254) Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Some axis runners and result envelopes exist under tests/benchmark/ and benchmark/results/.
- Blockers:
  - Multiple child axes remain partial or scaffolded; unified report still marks several sections pending.
- Next actions:
  - Close only after #1255-#1261 plus real-world follow-ups have headline-eligible measured rows.

### [#1255](https://github.com/shaun0927/openchrome/issues/1255) Benchmark #0: Harness Foundation — competitor adapters, exact tokenizer, env metadata

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Adapter files, exact tokenizer helpers, environment capture, and result schema exist.
- Blockers:
  - The suite is not yet proven with every live competitor adapter passing the same smoke task and pinned versions.
- Next actions:
  - Run a shared live smoke matrix for OpenChrome, Playwright, Puppeteer, playwright-mcp, browser-use, and Crawlee; commit version pins.

### [#1256](https://github.com/shaun0927/openchrome/issues/1256) Benchmark #A: Token Efficiency — payload tokens vs information retention

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - `npm run bench:tokens` emits deterministic-static, crawlee-cheerio, playwright-content, and playwright-innerText rows with explicit skips for remaining live-only cells.
- Blockers:
  - OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractors still require live/recorded-real wiring before headline token-efficiency claims.
- Next actions:
  - Wire remaining live extractor calls and version pins before publishing competitive token-efficiency claims.

### [#1257](https://github.com/shaun0927/openchrome/issues/1257) Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Controlled agent-success harness, mock workflow repetitions, task taxonomy, first-tool accuracy, and no-progress metrics exist.
- Blockers:
  - Live Claude/WebVoyager and competitor-native loops remain unwired, so current rows are controlled mock evidence only.
- Next actions:
  - Implement live/recorded-real adapter rows with pinned LLM settings and competitor versions before headline claims.

### [#1258](https://github.com/shaun0927/openchrome/issues/1258) Benchmark #C: Speed & Throughput — effective (success-weighted) throughput

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Latency and throughput runners exist; CI throughput uses deterministic OpenChrome stub; throughput can run Crawlee without Chrome and Playwright/Puppeteer/OpenChrome live through the shared adapter gate.
- Blockers:
  - Playwright/Puppeteer throughput cells require a live Chrome/CDP endpoint; session-reuse delta is still missing; headline competitor matrix needs operator-run live evidence.
- Next actions:
  - Run live Chrome throughput cells for OpenChrome/Playwright/Puppeteer and add session-reuse mode.

### [#1259](https://github.com/shaun0927/openchrome/issues/1259) Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Mock reliability matrix, Node-only long-run sampler, and real-world reliability methodology guardrails exist.
- Blockers:
  - Live fault-injection proxy/CDP cells, Chrome RSS/zombie sampling, and task-completion stress matrix remain unwired.
- Next actions:
  - Implement library-agnostic live fault injection inside real-world task episodes plus process sampling.

### [#1260](https://github.com/shaun0927/openchrome/issues/1260) Benchmark #E: Auth & Real-World Usability — logged-in success + setup cost

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Local auth fixture, setup scripts, LOC count, and profile-attach metadata exist.
- Blockers:
  - Wall-clock setup time and logged-in smoke success are null/pending in the current runner.
- Next actions:
  - Wire live local login-wall smoke for each library and keep third-party live tier best-effort only.

### [#1261](https://github.com/shaun0927/openchrome/issues/1261) Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - LOC matrix runner and DX scripts exist.
- Blockers:
  - Schema completeness and error actionability are emitted as null pending MCP introspection/failure induction.
- Next actions:
  - Add tools/list introspection for MCP competitors and fixed induced-failure scoring.

### [#1299](https://github.com/shaun0927/openchrome/issues/1299) Benchmark: Episode-level token cost to completion

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - `bench:episode:tokens` exists and reports deterministic mock episode token breakdowns through `tokenUsage`.
- Blockers:
  - Rows are controlled mock/local evidence; live LLM token/USD accounting and competitor-native task cost are not wired.
- Next actions:
  - Add live/recorded-real token accounting with pinned LLM settings, budgets, and competitor versions.

### [#1300](https://github.com/shaun0927/openchrome/issues/1300) Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Controlled mock workflow matrix includes categorized fixtures, repeated samples, first-tool accuracy, and no-progress metrics.
- Blockers:
  - The suite is still a controlled foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy.
- Next actions:
  - Expand taxonomy coverage and wire live/recorded-real adapter rows before headline use.

### [#1301](https://github.com/shaun0927/openchrome/issues/1301) Benchmark #B follow-up: real LLM repetitions and full-task metrics gate

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Budget constants and repetition CLI parsing exist.
- Blockers:
  - Real Anthropic Messages loop throws intentionally; `--repetitions` is not expanded into repeated samples; full-task token/USD accounting is missing.
- Next actions:
  - Implement Messages tool-use loop, repetition matrix, budget aborts, and sample-count gates.

### [#1302](https://github.com/shaun0927/openchrome/issues/1302) Benchmark #B follow-up: native/passive competitor adapter matrix

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Library routing identities and dry-run projection exist.
- Blockers:
  - playwright-mcp and browser-use native loops are marked `nativeLoopWired: false`.
- Next actions:
  - Wire native mode for playwright-mcp and browser-use and keep passive mode as secondary.

### [#1303](https://github.com/shaun0927/openchrome/issues/1303) Benchmark #D follow-up: inject reliability faults inside real-world tasks

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Reliability fault type taxonomy exists.
- Blockers:
  - Faults are not injected inside real-world task episodes and recovery is not judged by final task postconditions.
- Next actions:
  - Add stress-mode episode runner with deterministic fault checkpoints.

### [#1304](https://github.com/shaun0927/openchrome/issues/1304) Benchmark #D follow-up: real-world task completion as primary reliability signal

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Current code separates episode harness and reliability mock matrix.
- Blockers:
  - No library × task × repetition matrix uses real-world task completion as the primary reliability metric.
- Next actions:
  - Unify reliability reporting around task-completion episodes and demote isolated cells to stress diagnostics.

### [#1305](https://github.com/shaun0927/openchrome/issues/1305) Benchmark #G: Complex Real-World Task Completion

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - `bench:realworld`, deterministic real-world fixtures, scoring, result envelope, report generator, and docs exist.
- Blockers:
  - Current rows are deterministic scaffold/local-fixture evidence, not live competitive task-completion measurements.
- Next actions:
  - Add live/recorded-real OpenChrome and competitor rows with pinned versions and claim eligibility before headline claims.

### [#1310](https://github.com/shaun0927/openchrome/issues/1310) Benchmark: enforce headline eligibility for real-world episode claims

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Episode harness reports include `claimEligibility`, and the unified report documents primary evidence policy.
- Blockers:
  - Eligibility is not yet enforced across every real-world/live report path and cannot promote any row without live or recorded-real evidence.
- Next actions:
  - Extend claim eligibility checks to every live/recorded-real runner and fail report generation on missing eligibility metadata.

