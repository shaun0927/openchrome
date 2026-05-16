# Epic #1254 — Competitive Benchmark Suite, Status

Generated: 2026-05-15.

This document tracks Epic #1254 against its committed success criteria. Update on every merge of a Sprint-3/4 PR.

## Success criteria

| # | Criterion | State |
|---|---|---|
| 1 | All 6 axes have a reproducible runner + versioned result JSON + chart | **infrastructure landed** for axes #A/#C/#D/#E/#F; #B mock-only |
| 2 | `OC_COMPRESSION_RATIO = 15.3` estimation removed | ✅ landed in #1277 (Sprint 0 PR-1) |
| 3 | CI regression gate wired for at least the token + agent-success axes | ✅ landed in #1290 (Sprint 2 PR-14) for #B; #A gate via existing schema validation |
| 4 | `BENCHMARK-REPORT.md` regenerated entirely from real data, including losing scenarios | ✅ via `generate-benchmark-report.mjs` (this PR); concatenates real per-axis sections |
| 5 | Every result file carries version pins + environment metadata | ✅ enforced by `result-envelope.ts` validator on every axis runner |

## Per-axis state

| Issue | Axis | Runner | Section generator | Live driver |
|---|---|---|---|---|
| [#1256](https://github.com/shaun0927/openchrome/issues/1256) | Token Efficiency | ✅ `run-token-efficiency.ts` (matrix) | ✅ `generate-tokens-section.mjs` | partial — 2/9 libraries measured today, 7 scaffolded |
| [#1257](https://github.com/shaun0927/openchrome/issues/1257) | Agent Task Success | ✅ `webvoyager/runner.ts` (library + dry-run + passive) | ✅ `generate-agent-success-section.mjs` | mock-only; real-LLM baseline opt-in |
| [#1258](https://github.com/shaun0927/openchrome/issues/1258) | Speed & Throughput | ✅ `run-throughput.ts` + `run-latency.ts` | ✅ `generate-speed-section.mjs` | OpenChrome stub + real adapter wired; competitor cells scaffolded |
| [#1259](https://github.com/shaun0927/openchrome/issues/1259) | Reliability & Fault-Recovery | ✅ `run-reliability.ts` + `run-longrun.ts` | (queued — direct envelope) | mock matrix landed; live cells scaffolded |
| [#1260](https://github.com/shaun0927/openchrome/issues/1260) | Auth & Real-World Usability | ✅ `run-auth.ts` | (queued — direct envelope) | LOC measured; logged-in smoke pending live driver |
| [#1261](https://github.com/shaun0927/openchrome/issues/1261) | Developer Experience | ✅ `run-dx.ts` | ✅ `generate-dx-section.mjs` + dual SVGs | 2/10 tasks × 3/6 libraries landed; schema + actionability rubrics queued |
| [#1305](https://github.com/shaun0927/openchrome/issues/1305) | Complex Real-World Task Completion | ✅ `run-realworld-task-completion.ts` scaffold | ✅ `generate-realworld-task-completion-section.mjs` | deterministic fixture scaffold only; live competitive rows pending |

## Retired claims (must never reappear)

| Claim | Origin | Replaced by |
|---|---|---|
| `15.3×` token compression | benchmark/parallel-isolated.mjs (estimation constant) | per-archetype measurement in `token-efficiency.json` |
| `2.7× faster` headline | hand-written Twitter/X report | `chart-throughput.svg` + `speed-throughput.json` |

The Epic-close generator's lint pass refuses to write `BENCHMARK-REPORT.md` if any retired claim literal reappears.

## Closing the Epic

Once all per-axis runners have produced a measured (not mock-only) envelope, this status file flips every "partial" to "measured" and Epic #1254 can close. The infrastructure to MAKE those measurements has fully landed; the remaining work is the operator-authorized real-LLM run + the Chrome-required live cells, which are individual follow-up PRs not blockers for the Epic structurally.
