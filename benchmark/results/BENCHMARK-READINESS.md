# Open benchmark issue readiness audit

Generated: 2026-05-17T10:04:50.876Z

## Verdict

**NOT READY:** open benchmark issues are not fully implemented, and the current repo cannot measure every benchmark axis as publishable/headline evidence.

| Metric | Count |
| --- | ---: |
| Open benchmark issues audited | 15 |
| Ready | 0 |
| Partial | 10 |
| Not ready | 5 |
| Headline-measurement-ready | 0 |
| Diagnostic/smoke only | 10 |
| Not measurable yet | 5 |
| API-key-only ready | 0 |
| Blocked by non-key work | 15 |

## Issue matrix

| Issue | Status | Measurement readiness | API-key-only readiness | Primary non-key blocker |
| --- | --- | --- | --- | --- |
| [#1254](https://github.com/shaun0927/openchrome/issues/1254) Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source | not_ready | not_measurable | non_key_blockers | Multiple child axes remain partial or scaffolded; unified report still marks several sections pending. |
| [#1255](https://github.com/shaun0927/openchrome/issues/1255) Benchmark #0: Harness Foundation — competitor adapters, exact tokenizer, env metadata | partial | diagnostic_or_smoke_only | non_key_blockers | The suite is not yet proven with every live competitor adapter passing the same smoke task and pinned versions. |
| [#1256](https://github.com/shaun0927/openchrome/issues/1256) Benchmark #A: Token Efficiency — payload tokens vs information retention | partial | diagnostic_or_smoke_only | non_key_blockers | OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractors still require live/recorded-real wiring before headline token-efficiency claims. |
| [#1257](https://github.com/shaun0927/openchrome/issues/1257) Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget | partial | diagnostic_or_smoke_only | non_key_blockers | Live Claude/WebVoyager and competitor-native loops remain unwired, so current rows are controlled mock evidence only. |
| [#1258](https://github.com/shaun0927/openchrome/issues/1258) Benchmark #C: Speed & Throughput — effective (success-weighted) throughput | partial | diagnostic_or_smoke_only | non_key_blockers | Playwright/Puppeteer throughput cells require a live Chrome/CDP endpoint; session-reuse delta is still missing; headline competitor matrix needs operator-run live evidence. |
| [#1259](https://github.com/shaun0927/openchrome/issues/1259) Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie | partial | diagnostic_or_smoke_only | non_key_blockers | Live fault-injection proxy/CDP cells, Chrome RSS/zombie sampling, and task-completion stress matrix remain unwired. |
| [#1260](https://github.com/shaun0927/openchrome/issues/1260) Benchmark #E: Auth & Real-World Usability — logged-in success + setup cost | partial | diagnostic_or_smoke_only | non_key_blockers | Wall-clock setup time and logged-in smoke success are null/pending in the current runner. |
| [#1261](https://github.com/shaun0927/openchrome/issues/1261) Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability | partial | diagnostic_or_smoke_only | non_key_blockers | Schema completeness and error actionability are emitted as null pending MCP introspection/failure induction. |
| [#1299](https://github.com/shaun0927/openchrome/issues/1299) Benchmark: Episode-level token cost to completion | partial | diagnostic_or_smoke_only | non_key_blockers | Rows are controlled mock/local evidence; live LLM token/USD accounting and competitor-native task cost are not wired. |
| [#1300](https://github.com/shaun0927/openchrome/issues/1300) Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite | partial | diagnostic_or_smoke_only | non_key_blockers | The suite is still a controlled foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy. |
| [#1301](https://github.com/shaun0927/openchrome/issues/1301) Benchmark #B follow-up: real LLM repetitions and full-task metrics gate | not_ready | not_measurable | non_key_blockers | Real Anthropic Messages loop throws intentionally; `--repetitions` is not expanded into repeated samples; full-task token/USD accounting is missing. |
| [#1302](https://github.com/shaun0927/openchrome/issues/1302) Benchmark #B follow-up: native/passive competitor adapter matrix | not_ready | not_measurable | non_key_blockers | playwright-mcp and browser-use native loops are marked `nativeLoopWired: false`. |
| [#1303](https://github.com/shaun0927/openchrome/issues/1303) Benchmark #D follow-up: inject reliability faults inside real-world tasks | not_ready | not_measurable | non_key_blockers | Faults are not injected inside real-world task episodes and recovery is not judged by final task postconditions. |
| [#1304](https://github.com/shaun0927/openchrome/issues/1304) Benchmark #D follow-up: real-world task completion as primary reliability signal | not_ready | not_measurable | non_key_blockers | No library × task × repetition matrix uses real-world task completion as the primary reliability metric. |
| [#1310](https://github.com/shaun0927/openchrome/issues/1310) Benchmark: enforce headline eligibility for real-world episode claims | partial | diagnostic_or_smoke_only | non_key_blockers | Eligibility is not yet enforced across every real-world/live report path and cannot promote any row without live or recorded-real evidence. |

## Details

### [#1254](https://github.com/shaun0927/openchrome/issues/1254) Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source

- Status: `not_ready`
- Measurement readiness: `not_measurable`
- Evidence:
  - Some axis runners and result envelopes exist under tests/benchmark/ and benchmark/results/.
- Blockers:
  - Multiple child axes remain partial or scaffolded; unified report still marks several sections pending.
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `operator-owned live-site credentials for optional live tier`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
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
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
  - No library × task × repetition matrix uses real-world task completion as the primary reliability metric.
- Next actions:
  - Unify reliability reporting around task-completion episodes and demote isolated cells to stress diagnostics.

### [#1310](https://github.com/shaun0927/openchrome/issues/1310) Benchmark: enforce headline eligibility for real-world episode claims

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - Episode harness reports include `claimEligibility`, and the unified report documents primary evidence policy.
- Blockers:
  - Eligibility is not yet enforced across every real-world/live report path and cannot promote any row without live or recorded-real evidence.
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
  - Eligibility is not yet enforced across every real-world/live report path and cannot promote any row without live or recorded-real evidence.
- Next actions:
  - Extend claim eligibility checks to every live/recorded-real runner and fail report generation on missing eligibility metadata.


## Additional PR scopes to reach API-key-only readiness

These are the remaining non-key PRs needed before supplying API keys should be enough to run the full comparison.

### PR-A: Wire real LLM episode loops and repetition accounting

- Issues: #1257, #1299, #1301
- Objective: Connect the Anthropic/OpenAI tool-use loop seams to the WebVoyager and episode-token runners, expand task × library × mode × repetition cells, and persist full token/USD/budget-abort metrics.
- Acceptance criteria:
  - `--repetitions 10` writes ten samples per selected task/library/mode cell.
  - Live runs refuse to start without pinned provider/model/temperature/budget metadata.
  - Token, USD, tool-call, wall-time, and budget-abort fields are present in every live/recorded-real row.

### PR-B: Enable native/passive competitor matrix execution

- Issues: #1255, #1257, #1302
- Objective: Promote playwright-mcp and browser-use from native-loop scaffolds to runnable competitors and keep passive browser-use rows secondary/non-headline.
- Acceptance criteria:
  - `bench:webvoyager:real --library playwright-mcp --mode native` and `--library browser-use --mode native` run or emit explicit dependency-only setup errors.
  - Cross-library JSON separates native headline rows from passive secondary rows.
  - Competitor versions are pinned in result envelopes before comparison rows are publishable.

### PR-C: Wire live token-efficiency extractors and recorded payload ingestion

- Issues: #1256
- Objective: Replace token live-only stubs for OpenChrome read_page/AX, Playwright accessibility, playwright-mcp snapshot, and browser-use DOM serialization with real or recorded-live extractors.
- Acceptance criteria:
  - `OPENCHROME_BENCH_LIVE=1 npm run bench:tokens` measures all live extractor cells instead of throwing scaffold errors.
  - Recorded payloads include source/version/timestamp evidence and are validated before inclusion.
  - Reports distinguish live/recorded-real rows from deterministic diagnostic rows.

### PR-D: Make real-world completion and fault stress headline-eligible

- Issues: #1300, #1303, #1304, #1310, #1259
- Objective: Unify live/recorded-real real-world task completion with deterministic fault checkpoints, final postcondition recovery judging, and per-row claimEligibility.
- Acceptance criteria:
  - `bench:realworld` can run live/recorded-real OpenChrome and competitor rows with N>=10 aggregate samples.
  - Fault-injected rows set `fault_injected=true` and count recovered only when the final task postcondition passes.
  - `benchmark/generate-realworld-task-completion-section.mjs --require-headline` passes only with eligible live/recorded-real rows.

### PR-E: Finish speed/auth/DX live measurement gaps

- Issues: #1258, #1260, #1261
- Objective: Close remaining non-LLM measurement gaps: live throughput/session-reuse evidence, auth fixture wall-clock/pass evidence, MCP schema introspection, and induced error-actionability scoring.
- Acceptance criteria:
  - Throughput reports include live OpenChrome/Playwright/Puppeteer/Crawlee rows plus reuse-vs-cold deltas.
  - Auth reports include local login-wall pass/fail and setup minutes for every library.
  - DX reports include schema completeness and error actionability scores with null-free measured rows for MCP competitors.

### PR-F: Add full live benchmark orchestration and release gate

- Issues: #1254, #1255, #1310
- Objective: Provide one preflighted command that, after API keys and local runtime credentials are present, runs every axis, validates result envelopes, and blocks headline report publication on any diagnostic-only row.
- Acceptance criteria:
  - `npm run bench:full:live -- --preflight` reports only missing secrets/runtime services before execution.
  - The full command runs axes in dependency order and writes a unified report with no mock/scaffold headline rows.
  - `npm run bench:readiness -- --api-key-only` passes only when non-key blockers are gone.

