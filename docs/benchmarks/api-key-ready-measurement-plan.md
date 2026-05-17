# Benchmark API-key-only readiness plan

Generated from the benchmark readiness review after the May 17, 2026 benchmark PR train (#1328-#1336).

## Target state

The benchmark suite is **API-key-only ready** when a maintainer can provide the required LLM/API credentials and then run the full OpenChrome-vs-competitor comparison without any additional code changes, scaffold replacement, version-pin work, or manual result massaging.

That target still requires local runtime prerequisites such as Chrome/CDP availability and any competitor package installations already declared by the repository. Those are operational prerequisites, not missing benchmark implementation.

## Current verdict

The repository is **not API-key-only ready** yet.

Recent PRs added useful seams and fail-closed report gates:

- OpenAI/Anthropic tool-use loop helpers
- live real-world runner seam
- playwright-mcp and browser-use native helper surfaces
- live token extractor seam
- live throughput executor seam
- episode fault injection hooks
- recorded corpus validation
- real-world headline gate enforcement

However, every currently open benchmark issue still has at least one non-key blocker. Supplying `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or other credentials today would not by itself produce a complete, headline-eligible comparison.

## Non-key blockers found

| Area                 | Open issues         | Non-key blocker                                                                                                                                                                              |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness foundation   | #1255, #1254        | Shared live competitor smoke matrix and complete pinned competitor registry are not proven for every competitor.                                                                             |
| Token efficiency     | #1256               | OpenChrome read_page/AX, Playwright accessibility, playwright-mcp snapshot, and browser-use DOM extractors remain live-only/scaffold or recorded-payload-only paths.                         |
| Agent task success   | #1257, #1301, #1302 | WebVoyager repetitions are parsed but not expanded into repeated samples; the legacy Claude adapter still throws; playwright-mcp and browser-use remain `nativeLoopWired: false` in routing. |
| Speed/throughput     | #1258               | Live Chrome-backed competitor rows are possible through a seam but not yet backed by committed operator-run evidence and session reuse-vs-cold deltas.                                       |
| Reliability          | #1259, #1303, #1304 | Live reliability rows are `live_unwired_skip`; fault hooks are not integrated into real-world task episodes; task completion is not yet the primary reliability matrix.                      |
| Auth usability       | #1260               | Local login-wall fixture exists, but wall-clock setup time and logged-in success rows are still pending/null.                                                                                |
| Developer experience | #1261               | LOC rows exist, but schema completeness and induced error-actionability scoring are not populated for MCP competitors.                                                                       |
| Episode token cost   | #1299               | Deterministic/mock token breakdown exists, but live LLM/competitor-native token and USD accounting are not wired.                                                                            |
| Headline gating      | #1310               | The report gate correctly rejects mock/scaffold rows, but there are no eligible live or recorded-real rows to promote.                                                                       |

## Additional PR ladder

The readiness audit encodes the following PR scopes in `tests/benchmark/benchmark-readiness.ts` so release gates and reports can stay aligned with the implementation plan.

### PR-A — Wire real LLM episode loops and repetition accounting

Covers #1257, #1299, #1301.

Acceptance:

- `--repetitions 10` writes ten samples per selected task/library/mode cell.
- Live runs refuse to start without pinned provider/model/temperature/budget metadata.
- Token, USD, tool-call, wall-time, and budget-abort fields are present in every live/recorded-real row.

### PR-B — Enable native/passive competitor matrix execution

Covers #1255, #1257, #1302.

Acceptance:

- `bench:webvoyager:real --library playwright-mcp --mode native` and `--library browser-use --mode native` run or emit explicit dependency-only setup errors.
- Cross-library JSON separates native headline rows from passive secondary rows.
- Competitor versions are pinned in result envelopes before comparison rows are publishable.

### PR-C — Wire live token-efficiency extractors and recorded payload ingestion

Covers #1256.

Acceptance:

- `OPENCHROME_BENCH_LIVE=1 npm run bench:tokens` measures all live extractor cells instead of throwing scaffold errors.
- Recorded payloads include source/version/timestamp evidence and are validated before inclusion.
- Reports distinguish live/recorded-real rows from deterministic diagnostic rows.

### PR-D — Make real-world completion and fault stress headline-eligible

Covers #1259, #1300, #1303, #1304, #1310.

Acceptance:

- `bench:realworld` can run live/recorded-real OpenChrome and competitor rows with N>=10 aggregate samples.
- Fault-injected rows set `fault_injected=true` and count recovered only when the final task postcondition passes.
- `benchmark/generate-realworld-task-completion-section.mjs --require-headline` passes only with eligible live/recorded-real rows.

### PR-E — Finish speed/auth/DX live measurement gaps

Covers #1258, #1260, #1261.

Acceptance:

- Throughput reports include live OpenChrome/Playwright/Puppeteer/Crawlee rows plus reuse-vs-cold deltas.
- Auth reports include local login-wall pass/fail and setup minutes for every library.
- DX reports include schema completeness and error actionability scores with null-free measured rows for MCP competitors.

### PR-F — Add full live benchmark orchestration and release gate

Covers #1254, #1255, #1310.

Acceptance:

- `npm run bench:full:live -- --preflight` reports only missing secrets/runtime services before execution.
- The full command runs axes in dependency order and writes a unified report with no mock/scaffold headline rows.
- `npm run bench:readiness -- --api-key-only` passes only when non-key blockers are gone.

## Scope of this PR

This PR does not pretend to close all live benchmark implementation gaps. Its scope is the release-safety and planning layer needed before those implementation PRs land:

1. Make the readiness audit distinguish ordinary headline readiness from **API-key-only readiness**.
2. Remove closed #1305 from the open benchmark issue audit and keep #1310 as the open real-world headline gate.
3. Encode the additional PR ladder above as repo-native data emitted in JSON and Markdown reports.
4. Add `bench:api-key-readiness` / `--api-key-only` as a fail-closed gate for future release workflows.

This prevents a future API-key-provided run from being mistaken as ready while non-key implementation gaps remain.
