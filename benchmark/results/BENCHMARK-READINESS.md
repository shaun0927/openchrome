# Open benchmark issue readiness audit

Generated: 2026-05-16T01:39:15.114Z

## Verdict

**NOT READY:** open benchmark issues are not fully implemented, and the current repo cannot measure every benchmark axis as publishable/headline evidence.

| Metric | Count |
| --- | ---: |
| Open benchmark issues audited | 16 |
| Ready | 0 |
| Partial | 5 |
| Not ready | 11 |
| Headline-measurement-ready | 0 |
| Diagnostic/smoke only | 8 |
| Not measurable yet | 8 |

## Issue matrix

| Issue | Status | Measurement readiness | Primary blocker |
| --- | --- | --- | --- |
| [#1254](https://github.com/shaun0927/openchrome/issues/1254) Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source | not_ready | not_measurable | Multiple child axes remain partial or scaffolded; unified report still marks several sections pending. |
| [#1255](https://github.com/shaun0927/openchrome/issues/1255) Benchmark #0: Harness Foundation — competitor adapters, exact tokenizer, env metadata | partial | diagnostic_or_smoke_only | The suite is not yet proven with every live competitor adapter passing the same smoke task and pinned versions. |
| [#1256](https://github.com/shaun0927/openchrome/issues/1256) Benchmark #A: Token Efficiency — payload tokens vs information retention | partial | diagnostic_or_smoke_only | OpenChrome, Playwright, playwright-mcp, and browser-use extractors are live-only scaffolds that throw when live mode is enabled. |
| [#1257](https://github.com/shaun0927/openchrome/issues/1257) Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget | not_ready | diagnostic_or_smoke_only | Real Claude tool-use loop is a deliberate scaffold; 7 WebVoyager tasks remain pending; repetitions are parsed but not executed; competitor native loops are unwired. |
| [#1258](https://github.com/shaun0927/openchrome/issues/1258) Benchmark #C: Speed & Throughput — effective (success-weighted) throughput | partial | diagnostic_or_smoke_only | Throughput competitor adapters are not wired through the runner; session-reuse delta is missing; headline competitor matrix is not complete. |
| [#1259](https://github.com/shaun0927/openchrome/issues/1259) Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie | not_ready | diagnostic_or_smoke_only | Live fault-injection proxy/CDP cells are scaffolded; Chrome RSS and zombie-process sampling are not wired; cross-platform live table is missing. |
| [#1260](https://github.com/shaun0927/openchrome/issues/1260) Benchmark #E: Auth & Real-World Usability — logged-in success + setup cost | partial | diagnostic_or_smoke_only | Wall-clock setup time and logged-in smoke success are null/pending in the current runner. |
| [#1261](https://github.com/shaun0927/openchrome/issues/1261) Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability | partial | diagnostic_or_smoke_only | Schema completeness and error actionability are emitted as null pending MCP introspection/failure induction. |
| [#1299](https://github.com/shaun0927/openchrome/issues/1299) Benchmark: Episode-level token cost to completion | not_ready | not_measurable | Episode result types do not yet include token category breakdowns or `bench:episode:tokens` script. |
| [#1300](https://github.com/shaun0927/openchrome/issues/1300) Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite | not_ready | diagnostic_or_smoke_only | The required taxonomy suite (`info_retrieval`, `form_fill`, `transactional_mock`, `recovery`, `dynamic_ui`, `long_horizon`) is not implemented as a benchmark matrix. |
| [#1301](https://github.com/shaun0927/openchrome/issues/1301) Benchmark #B follow-up: real LLM repetitions and full-task metrics gate | not_ready | not_measurable | Real Anthropic Messages loop throws intentionally; `--repetitions` is not expanded into repeated samples; full-task token/USD accounting is missing. |
| [#1302](https://github.com/shaun0927/openchrome/issues/1302) Benchmark #B follow-up: native/passive competitor adapter matrix | not_ready | not_measurable | playwright-mcp and browser-use native loops are marked `nativeLoopWired: false`. |
| [#1303](https://github.com/shaun0927/openchrome/issues/1303) Benchmark #D follow-up: inject reliability faults inside real-world tasks | not_ready | not_measurable | Faults are not injected inside real-world task episodes and recovery is not judged by final task postconditions. |
| [#1304](https://github.com/shaun0927/openchrome/issues/1304) Benchmark #D follow-up: real-world task completion as primary reliability signal | not_ready | not_measurable | No library × task × repetition matrix uses real-world task completion as the primary reliability metric. |
| [#1305](https://github.com/shaun0927/openchrome/issues/1305) Benchmark #G: Complex Real-World Task Completion | not_ready | not_measurable | `tests/benchmark/run-realworld-task-completion.ts`, result envelope, report generator, and docs are missing. |
| [#1310](https://github.com/shaun0927/openchrome/issues/1310) Benchmark: enforce headline eligibility for real-world episode claims | not_ready | not_measurable | The enforcement PR is separate and not yet merged into this base branch. |

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
  - `npm run bench:tokens` can emit deterministic-static and crawlee-cheerio rows.
- Blockers:
  - OpenChrome, Playwright, playwright-mcp, and browser-use extractors are live-only scaffolds that throw when live mode is enabled.
- Next actions:
  - Wire live extractor calls and version pins before publishing competitive token-efficiency claims.

### [#1257](https://github.com/shaun0927/openchrome/issues/1257) Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget

- Status: `not_ready`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Mock WebVoyager runner exists and records 3 required frozen transcripts.
- Blockers:
  - Real Claude tool-use loop is a deliberate scaffold; 7 WebVoyager tasks remain pending; repetitions are parsed but not executed; competitor native loops are unwired.
- Next actions:
  - Implement real LLM loop, real repetitions, remaining transcripts, and native competitor adapters.

### [#1258](https://github.com/shaun0927/openchrome/issues/1258) Benchmark #C: Speed & Throughput — effective (success-weighted) throughput

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Latency and throughput runners exist; CI throughput uses deterministic OpenChrome stub; latency can use OpenChrome real adapter when Chrome is available.
- Blockers:
  - Throughput competitor adapters are not wired through the runner; session-reuse delta is missing; headline competitor matrix is not complete.
- Next actions:
  - Wire Playwright/Puppeteer/Crawlee throughput cells and add session-reuse mode.

### [#1259](https://github.com/shaun0927/openchrome/issues/1259) Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie

- Status: `not_ready`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Mock reliability matrix and Node-only long-run sampler exist.
- Blockers:
  - Live fault-injection proxy/CDP cells are scaffolded; Chrome RSS and zombie-process sampling are not wired; cross-platform live table is missing.
- Next actions:
  - Implement library-agnostic live fault injection plus Chrome/process sampling.

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

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Episode harness records steps, tool calls, duration, errors, and no-progress episodes.
- Blockers:
  - Episode result types do not yet include token category breakdowns or `bench:episode:tokens` script.
- Next actions:
  - Add episode token accounting helpers, reporter aggregation, and npm script.

### [#1300](https://github.com/shaun0927/openchrome/issues/1300) Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite

- Status: `not_ready`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Episode harness has three local mock fixtures.
- Blockers:
  - The required taxonomy suite (`info_retrieval`, `form_fill`, `transactional_mock`, `recovery`, `dynamic_ui`, `long_horizon`) is not implemented as a benchmark matrix.
- Next actions:
  - Add CI-safe controlled workflow tasks with explicit categories and outcome contracts.

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

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - No `bench:realworld` script exists in package.json on this branch.
- Blockers:
  - `tests/benchmark/run-realworld-task-completion.ts`, result envelope, report generator, and docs are missing.
- Next actions:
  - Implement `bench:realworld` around the episode envelope and headline eligibility rules.

### [#1310](https://github.com/shaun0927/openchrome/issues/1310) Benchmark: enforce headline eligibility for real-world episode claims

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Issue exists to coordinate report-layer headline eligibility across #1300-#1305.
- Blockers:
  - The enforcement PR is separate and not yet merged into this base branch.
- Next actions:
  - Merge the headline eligibility work, then extend it to the real-world runner.

