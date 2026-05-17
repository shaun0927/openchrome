# Open benchmark issue readiness audit

Generated: 2026-05-17T16:18:01.062Z

## Verdict

**NOT READY:** open benchmark issues are not fully implemented, and the current repo cannot measure every benchmark axis as publishable/headline evidence.

| Metric | Count |
| --- | ---: |
| Open benchmark issues audited | 15 |
| Ready | 0 |
| Partial | 11 |
| Not ready | 4 |
| Headline-measurement-ready | 0 |
| Diagnostic/smoke only | 11 |
| Not measurable yet | 4 |
| API-key-only ready | 0 |
| Blocked by non-key work | 15 |
| Stale OpenChrome result artifacts | 4 |

## Issue matrix

| Issue | Status | Measurement readiness | API-key-only readiness | Primary non-key blocker |
| --- | --- | --- | --- | --- |
| [#1254](https://github.com/shaun0927/openchrome/issues/1254) Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source | not_ready | not_measurable | non_key_blockers | Multiple child axes remain partial or scaffolded; unified report still marks several sections pending. |
| [#1255](https://github.com/shaun0927/openchrome/issues/1255) Benchmark #0: Harness Foundation — competitor adapters, exact tokenizer, env metadata | partial | diagnostic_or_smoke_only | non_key_blockers | The suite is not yet proven with every live competitor adapter passing the same smoke task and pinned versions. |
| [#1256](https://github.com/shaun0927/openchrome/issues/1256) Benchmark #A: Token Efficiency — payload tokens vs information retention | partial | diagnostic_or_smoke_only | non_key_blockers | Live OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractor rows still require live/recorded-real evidence before headline token-efficiency claims. |
| [#1257](https://github.com/shaun0927/openchrome/issues/1257) Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget | partial | diagnostic_or_smoke_only | non_key_blockers | Live Claude/WebVoyager and competitor-native loops remain unwired, so current rows are controlled mock evidence only. |
| [#1258](https://github.com/shaun0927/openchrome/issues/1258) Benchmark #C: Speed & Throughput — effective (success-weighted) throughput | partial | diagnostic_or_smoke_only | non_key_blockers | Playwright/Puppeteer live throughput cells still require an operator-run Chrome/CDP endpoint, so the headline competitor matrix needs live evidence before promotion. |
| [#1259](https://github.com/shaun0927/openchrome/issues/1259) Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie | partial | diagnostic_or_smoke_only | non_key_blockers | Live fault-injection proxy/CDP cells, Chrome RSS/zombie sampling, and task-completion stress matrix remain unwired. |
| [#1260](https://github.com/shaun0927/openchrome/issues/1260) Benchmark #E: Auth & Real-World Usability — logged-in success + setup cost | partial | diagnostic_or_smoke_only | non_key_blockers | Third-party live-site auth remains operator-provided only, so local fixture rows must stay diagnostic unless a live/recorded-real tier is supplied. |
| [#1261](https://github.com/shaun0927/openchrome/issues/1261) Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability | partial | diagnostic_or_smoke_only | non_key_blockers | Additional MCP competitors still need tools/list introspection fixtures before schema completeness can be compared across the full MCP matrix. |
| [#1299](https://github.com/shaun0927/openchrome/issues/1299) Benchmark: Episode-level token cost to completion | partial | diagnostic_or_smoke_only | non_key_blockers | Rows are controlled mock/local evidence; live LLM token/USD accounting and competitor-native task cost are not wired. |
| [#1300](https://github.com/shaun0927/openchrome/issues/1300) Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite | partial | diagnostic_or_smoke_only | non_key_blockers | The suite is still a local deterministic foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy. |
| [#1301](https://github.com/shaun0927/openchrome/issues/1301) Benchmark #B follow-up: real LLM repetitions and full-task metrics gate | not_ready | not_measurable | non_key_blockers | Real Anthropic Messages loop throws intentionally; `--repetitions` is not expanded into repeated samples; full-task token/USD accounting is missing. |
| [#1302](https://github.com/shaun0927/openchrome/issues/1302) Benchmark #B follow-up: native/passive competitor adapter matrix | not_ready | not_measurable | non_key_blockers | playwright-mcp and browser-use native loops are marked `nativeLoopWired: false`. |
| [#1303](https://github.com/shaun0927/openchrome/issues/1303) Benchmark #D follow-up: inject reliability faults inside real-world tasks | not_ready | not_measurable | non_key_blockers | Faults are not injected inside real-world task episodes and recovery is not judged by final task postconditions. |
| [#1304](https://github.com/shaun0927/openchrome/issues/1304) Benchmark #D follow-up: real-world task completion as primary reliability signal | partial | diagnostic_or_smoke_only | non_key_blockers | No live/recorded-real library × task × repetition matrix uses real-world task completion as the primary reliability metric yet. |
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
  - `npm run bench:tokens` emits deterministic-static, crawlee-cheerio, playwright-content, and playwright-innerText rows with explicit live-only skips for playwright-mcp and browser-use cells.
- Blockers:
  - Live OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractor rows still require live/recorded-real evidence before headline token-efficiency claims.
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
  - Live OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractor rows still require live/recorded-real evidence before headline token-efficiency claims.
- Next actions:
  - Run and pin the remaining live/recorded-real extractor cells before publishing competitive token-efficiency claims.

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
  - Latency and throughput runners exist; CI throughput records deterministic OpenChrome stub and no-Chrome Crawlee rows across both reuse and cold session modes.
- Blockers:
  - Playwright/Puppeteer live throughput cells still require an operator-run Chrome/CDP endpoint, so the headline competitor matrix needs live evidence before promotion.
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
  - Playwright/Puppeteer live throughput cells still require an operator-run Chrome/CDP endpoint, so the headline competitor matrix needs live evidence before promotion.
- Next actions:
  - Run live Chrome throughput cells for OpenChrome/Playwright/Puppeteer and keep cold-vs-reuse rows separate in reporting.

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
  - Local auth fixture, setup scripts, LOC count, profile-attach metadata, wall-clock local fixture timing, and logged-in smoke success rows exist.
- Blockers:
  - Third-party live-site auth remains operator-provided only, so local fixture rows must stay diagnostic unless a live/recorded-real tier is supplied.
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `operator-owned live-site credentials for optional live tier`
- Non-key blockers:
  - Third-party live-site auth remains operator-provided only, so local fixture rows must stay diagnostic unless a live/recorded-real tier is supplied.
- Next actions:
  - Keep local login-wall smoke as the default no-secret measurement and add optional operator-owned live-site rows only with explicit credentials.

### [#1261](https://github.com/shaun0927/openchrome/issues/1261) Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - LOC matrix runner, DX scripts, OpenChrome schema-completeness fixtures, and induced-error actionability scoring exist with explicit measured/not-applicable/missing-fixture statuses.
- Blockers:
  - Additional MCP competitors still need tools/list introspection fixtures before schema completeness can be compared across the full MCP matrix.
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
  - Additional MCP competitors still need tools/list introspection fixtures before schema completeness can be compared across the full MCP matrix.
- Next actions:
  - Add tools/list introspection for remaining MCP competitors and preserve explicit status fields for non-applicable framework rows.

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
  - Controlled task corpus covers info_retrieval, form_fill, transactional_mock, recovery, dynamic_ui, and long_horizon with reset contracts and final postcondition evidence.
- Blockers:
  - The suite is still a local deterministic foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy.
- API-key-only readiness: `non_key_blockers`
- Non-key blockers:
  - The suite is still a local deterministic foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy.
- Next actions:
  - Wire live/recorded-real adapter rows over the committed task contracts before headline use.

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

- Status: `partial`
- Measurement readiness: `diagnostic_or_smoke_only`
- Evidence:
  - The real-world task-completion runner emits a local deterministic library × task matrix with final postcondition evidence and diagnostic-only claim eligibility.
- Blockers:
  - No live/recorded-real library × task × repetition matrix uses real-world task completion as the primary reliability metric yet.
- API-key-only readiness: `non_key_blockers`
- Required secrets after non-key blockers clear: `ANTHROPIC_API_KEY or OPENAI_API_KEY`
- Non-key blockers:
  - No live/recorded-real library × task × repetition matrix uses real-world task completion as the primary reliability metric yet.
- Next actions:
  - Add repeated live/recorded-real task-completion rows and connect reliability stress signals to these final postcondition contracts.

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


## Result artifact freshness

Current OpenChrome package version: `1.12.4`.
These committed result artifacts contain OpenChrome version pins older than the current package version. They remain diagnostic until regenerated or explicitly superseded:

| Artifact | Expected OpenChrome version | Found OpenChrome versions |
| --- | --- | --- |
| `benchmark/results/episode-token-cost.json` | `1.12.4` | `1.12.2` |
| `benchmark/results/longrun-stability.json` | `1.12.4` | `1.11.0` |
| `benchmark/results/reliability.json` | `1.12.4` | `1.12.2` |
| `benchmark/results/runtime-preflight.json` | `1.12.4` | `1.12.2` |

## Additional PR scopes to reach API-key-only readiness

These are the remaining non-key PRs needed before supplying API keys should be enough to run the full comparison.

### PR1: Benchmark contract hardening and headline safety gates

- Issues: #1255, #1310
- Objective: Centralize row status and claimEligibility semantics, enforce no mock/scaffold/dry-run headline claims, add stale artifact/version detection, and update readiness/report validation.
- Rationale: This is the first dependency because every later axis needs the same measured/skip/diagnostic/headline vocabulary before it can safely publish rows.
- In scope:
  - common benchmark row status vocabulary
  - claimEligibility validation for rows and aggregates
  - headline-gate tests for mock/scaffold/dry-run/undersampled rows
  - stale result artifact detection
  - measurement-tier documentation
- Out of scope:
  - real LLM execution
  - competitor native loop implementation
  - new live measurements
  - OpenChrome product/core changes
- Likely files:
  - tests/benchmark/utils/*
  - tests/benchmark/benchmark-readiness.ts
  - benchmark/claim-eligibility.mjs
  - benchmark/headline-gate.mjs
  - docs/benchmarks/*
  - benchmark/results/* generated artifacts
- Acceptance criteria:
  - Readiness report exposes stale OpenChrome result artifacts separately from implementation readiness.
  - Headline gates fail closed for missing/ineligible claimEligibility and diagnostic modes.
  - Scope remains benchmark-harness only.
- Verification:
  - npm test -- --runTestsByPath tests/benchmark/benchmark-readiness.test.ts tests/benchmark/utils/artifact-freshness.test.ts tests/benchmark/episode-harness/claim-eligibility.test.ts --runInBand
  - node benchmark/claim-eligibility.test.mjs
  - node benchmark/headline-gate.test.mjs
  - npm run bench:readiness
  - npm run build

### PR2: Competitor smoke matrix and version pin enforcement

- Issues: #1255, #1302
- Objective: Make benchmark/COMPETITORS.md authoritative, strengthen bench:competitor-smoke, detect dependency/runtime availability, capture actual versions, and emit explicit skip rows without faking competitors.
- Rationale: Live axes need trustworthy competitor availability and version provenance before measurements are meaningful.
- In scope:
  - authoritative competitor manifest
  - version capture
  - dependency_missing/not_wired/runtime_failed skip rows
  - shared smoke task contract
  - readiness integration
- Out of scope:
  - full native browser-use/playwright-mcp LLM loops
  - headline comparisons
  - automatic heavyweight dependency installs
  - OpenChrome core changes
- Likely files:
  - benchmark/COMPETITORS.md
  - tests/benchmark/run-competitor-smoke.ts
  - tests/benchmark/adapters/*
  - benchmark/results/competitor-smoke.json
- Acceptance criteria:
  - Every competitor has measured or explicit skip status.
  - Version pins are recorded before comparable rows are eligible.
  - Skip rows are visible and excluded from headline aggregates.
- Verification:
  - npm run bench:competitor-smoke
  - npm test -- --runTestsByPath tests/benchmark/adapters/browser-use-adapter.test.ts tests/benchmark/adapters/playwright-mcp-adapter.test.ts tests/benchmark/benchmark-readiness.test.ts --runInBand
  - npm run build

### PR3: Finish non-LLM benchmark measurement gaps

- Issues: #1256, #1258, #1260, #1261
- Objective: Finish token payload live/recorded extractors, speed throughput cold/warm/session-reuse evidence, auth local fixture setup/pass timing, and DX schema/error-actionability rows.
- Rationale: These axes can be advanced without paid LLM API keys and validate the contract from PR1.
- In scope:
  - token payload live/recorded rows
  - throughput cold/warm/session reuse rows
  - auth setup timing and login smoke rows
  - DX schema completeness and induced error actionability scoring
- Out of scope:
  - LLM task success
  - browser-use native agent loop
  - real-world fault injection
  - full orchestration
- Likely files:
  - tests/benchmark/run-token-efficiency.ts
  - tests/benchmark/run-throughput.ts
  - tests/benchmark/run-auth.ts
  - tests/benchmark/run-dx.ts
  - benchmark/generate-*-section.mjs
- Acceptance criteria:
  - Non-LLM rows are measured or explicitly skipped without null headline metrics.
  - Reports distinguish live/recorded-real from diagnostic rows.
  - No paid/API-key path is required.
- Verification:
  - npm run bench:tokens
  - npm run bench:throughput
  - npm run bench:auth
  - npm run bench:dx
  - npm run build

### PR4: Controlled real-world task corpus and postcondition contracts

- Issues: #1300, #1304
- Objective: Cover info_retrieval, form_fill, transactional_mock, recovery, dynamic_ui, and long_horizon with local fixtures, reset state, success contracts, final postcondition evidence, and diagnostic reporting.
- Rationale: Task contracts must be stable before expensive live LLM runs or reliability stress rows.
- In scope:
  - full controlled taxonomy
  - local/resettable fixtures
  - outcome-contract assertions
  - final postcondition evidence
  - diagnostic report separation
- Out of scope:
  - real LLM loop
  - competitor native execution
  - fault stress implementation
  - headline competitive claims
- Likely files:
  - tests/benchmark/realworld-task-completion/*
  - tests/benchmark/run-realworld-task-completion.ts
  - benchmark/generate-realworld-task-completion-section.mjs
  - docs/benchmarks/benchmark-direction.md
- Acceptance criteria:
  - Every required category has at least one deterministic task.
  - Each task has reset and postcondition evidence.
  - Local rows remain diagnostic-only.
- Verification:
  - npm run bench:realworld
  - node benchmark/generate-realworld-task-completion-section.mjs
  - npm run build

### PR5: Real LLM runner, repetitions, budget, and token-cost accounting

- Issues: #1257, #1299, #1301
- Objective: Add provider abstraction, real Anthropic/OpenAI tool-use loop seams, budget caps, token/USD accounting, task x library x mode x repetition sample persistence, and N gates.
- Rationale: After task corpus is stable, the high-cost live path can be implemented as opt-in and preflighted.
- In scope:
  - provider/model/temperature/budget metadata
  - repetition matrix expansion
  - token/USD/tool-call/wall-time/budget-abort fields
  - recorded-real sample schema
  - fail-closed preflight
- Out of scope:
  - browser-use/playwright-mcp native loops beyond seams
  - fault injection
  - full orchestration
  - default CI API calls
- Likely files:
  - tests/benchmark/webvoyager/llm/*
  - tests/benchmark/webvoyager/runner.ts
  - tests/benchmark/run-episode-token-cost.ts
  - docs/benchmarks/webvoyager.md
- Acceptance criteria:
  - --repetitions writes independent samples.
  - Live runs refuse without pinned model/settings/budget.
  - Token/USD fields exist for live/recorded-real rows.
- Verification:
  - npm run bench:webvoyager:mock
  - npm run bench:episode:tokens
  - dry-run/preflight proves no API call without explicit env
  - npm run build

### PR6: Native competitor execution for playwright-mcp and browser-use

- Issues: #1302, #1257
- Objective: Run playwright-mcp and browser-use as real external competitors, preserve passive rows as secondary, pin exact versions, and prevent fallback to OpenChrome.
- Rationale: Competitor loops should use the same LLM/repetition contract rather than creating schema churn earlier.
- In scope:
  - playwright-mcp external MCP invocation
  - browser-use bridge/native invocation
  - native vs passive row separation
  - dependency-only setup errors
  - exact version capture
- Out of scope:
  - reimplementing competitor behavior
  - OpenChrome product changes
  - fault injection
  - full orchestration
- Likely files:
  - tests/benchmark/adapters/playwright-mcp-adapter.ts
  - tests/benchmark/adapters/browser-use-adapter.ts
  - tests/benchmark/webvoyager/llm/library-routing.ts
  - scripts/bench/setup-browser-use.sh
- Acceptance criteria:
  - Native competitor rows run or explicit dependency-only skips are emitted.
  - Passive rows are never headline substitutes.
  - No OpenChrome fallback is possible.
- Verification:
  - npm run bench:competitor-smoke
  - npm run bench:webvoyager:real -- --library playwright-mcp --mode native --dry-run
  - npm run bench:webvoyager:real -- --library browser-use --mode native --dry-run
  - npm run build

### PR7: Fault injection inside real-world task episodes

- Issues: #1259, #1303, #1304
- Objective: Inject deterministic faults inside real-world task episodes, mark fault rows, judge recovered only by final postcondition, and add recovery timing plus Chrome RSS/zombie sampling.
- Rationale: This converts reliability into task-completion stress evidence instead of isolated fault cells.
- In scope:
  - fault checkpoint schema
  - fault rows
  - final-postcondition recovery judging
  - recovery time/steps
  - Chrome RSS/zombie sampling
- Out of scope:
  - new task taxonomy beyond PR4
  - real LLM provider implementation
  - competitor native wiring
  - headline promotion without gates
- Likely files:
  - tests/benchmark/realworld-task-completion/*
  - tests/benchmark/run-reliability.ts
  - tests/benchmark/run-longrun.ts
  - benchmark/RELIABILITY-REALWORLD-PLAN.md
- Acceptance criteria:
  - fault_injected rows are explicit.
  - Recovered means final postcondition passes.
  - Stress rows stay diagnostic unless eligibility gates pass.
- Verification:
  - npm run bench:reliability
  - npm run bench:realworld -- --stress or equivalent
  - npm run build

### PR8: Full live/recorded benchmark orchestration and release gate

- Issues: #1254, #1310
- Objective: Add bench:full:live --preflight, bench:full:recorded, dependency ordering, cost estimate, unified headline gate, strict readiness pass, and release workflow integration.
- Rationale: The final PR should integrate completed axes rather than inventing missing axis semantics.
- In scope:
  - full preflight reporting missing secrets/runtime services
  - ordered live/recorded wrapper
  - cost estimate
  - unified no-diagnostic-headline report gate
  - strict/api-key readiness gates
- Out of scope:
  - axis-specific implementations not completed earlier
  - automatic paid API calls in CI
  - bypassing claimEligibility
- Likely files:
  - package.json
  - tests/benchmark/benchmark-readiness.ts
  - tests/benchmark/runtime-preflight.ts
  - benchmark/generate-benchmark-report.mjs
  - benchmark/headline-gate.mjs
  - .github/workflows/benchmark-*.yml
- Acceptance criteria:
  - bench:full:live --preflight reports only missing prerequisites.
  - Unified report contains no mock/scaffold headline rows.
  - strict readiness passes only when justified by artifacts.
- Verification:
  - npm run bench:full:live -- --preflight or equivalent
  - npm run bench:readiness -- --strict
  - npm run bench:api-key-readiness
  - npm run build

