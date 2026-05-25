# WebVoyager contract-eval benchmark

OpenChrome's contract-eval benchmark on a WebVoyager-style task set. Lives in
`tests/benchmark/webvoyager/`. The judge is `src/contracts/evaluate.ts` — **not
an LLM**. Eliminates the self-vs-LLM-eval gap by construction.

## Quick run

```bash
# Deterministic replay over frozen transcripts (CI default).
npm run bench:webvoyager:mock

# Real Claude API run (opt-in; spends money). Prefer file/stdin/env-ref
# benchmark-only secret input flags over exporting long-lived shell env.
OPENCHROME_BENCH_REAL=1 \
  npm run bench:webvoyager:real -- \
  --anthropic-api-key-file ~/.config/openchrome/anthropic-benchmark.key \
  --task task-01-example-com-title

# Equivalent one-shot stdin form; the key is copied into ANTHROPIC_API_KEY only
# for this Node process.
printf '%s' "$ANTHROPIC_API_KEY" | OPENCHROME_BENCH_REAL=1 \
  npm run bench:webvoyager:real -- --api-key-stdin=anthropic --preflight

# Fail-closed live preflight; exits non-zero if env/model prerequisites are missing
# and does not make an API call.
npm run bench:webvoyager:real -- --preflight

# OpenAI seam uses the same preflight/repetition/report metadata contract.
npx ts-node tests/benchmark/webvoyager/runner.ts --adapter openai --preflight
```

Reports land in `tests/benchmark/webvoyager/reports/<git-sha>.{json,md}`
plus stable `latest.{json,md}` pointers.


## Scope note for Agent Task Success

WebVoyager-style public-web lookup is only one layer of #1257. It is valuable for
stable navigation and information retrieval, but it is not sufficient by itself
for a headline Agent Task Success claim. Stateful controlled workflows live in
`tests/benchmark/episode-harness` and are documented in
`docs/benchmarks/agent-task-success.md`.

## Adapters

| Adapter | Env | Notes |
| --- | --- | --- |
| `mock` | (default) | Replays JSONL transcripts under `transcripts/`. Deterministic, no network, no API key. CI uses this. |
| `claude` | `OPENCHROME_BENCH_ADAPTER=claude`, `ANTHROPIC_API_KEY` or `--anthropic-api-key-file` / `--api-key-stdin=anthropic`, `OPENCHROME_BENCH_REAL=1` | Anthropic Messages API seam. Requires `@anthropic-ai/sdk` installed locally (`npm i -D @anthropic-ai/sdk`) before live execution. Preflight reports missing prerequisites before any API call. |
| `openai` | `OPENAI_API_KEY` or `--openai-api-key-file` / `--api-key-stdin=openai`, `OPENCHROME_BENCH_REAL=1` | OpenAI tool-use seam using the same metadata, budget, and preflight contract. It is opt-in only and is not run by CI. |

## Benchmark-only API key input

Live benchmark commands accept process-local secret input flags before provider
preflight runs:

- `--anthropic-api-key-file <path>` / `--openai-api-key-file <path>`
- `--api-key-stdin=anthropic` / `--api-key-stdin=openai`
- `--api-key-env <ENV_NAME> --api-key-env-provider <anthropic|openai>`
- `--anthropic-api-key <value>` / `--openai-api-key <value>` for controlled CI only

The flags are benchmark-only conveniences under `tests/benchmark`; they do not
write a credential store. Inline key values are redacted from benchmark argv
diagnostics, but file/stdin/env-ref forms are preferred because inline flags can
remain in shell history.

## Repetitions and live-run metadata

`--repetitions N` expands into N independent task samples per selected task and
records the sample index in each row. Live/recorded-real reports must also pin:

- provider and model
- temperature
- max tokens per turn
- max tool iterations
- max USD per task
- per-row input/output/total tokens, USD, and budget-abort reason when available

Rows without live or recorded-real evidence remain diagnostic, even when they
use the same report schema.

## Transcript determinism contract

Frozen transcripts are JSONL files containing zero or more `tool_call` entries
followed by a `final_state`. Every `tool_call` entry must include:

- `tool` — the MCP tool name invoked by the recording adapter.
- `args` — the exact JSON-compatible argument object sent to that tool.
- `args_digest_sha256` — `sha256(deterministicStringify(args))`.
- `response_kind` — a compact response classification used for report metrics.

`deterministicStringify` sorts object keys recursively, preserves array order,
drops `undefined` object fields the same way JSON does, and emits no whitespace.
The mock adapter recomputes every digest before contract evaluation. A mismatch
returns `replay_drift` with `{ expected, actual, tool, step_index }`, catching
the case where a transcript keeps the same tool sequence but silently mutates
arguments.

## Budget caps

Defined in `llm/budget.ts`, applied by real provider adapters:

| Cap | Value | Effect |
| --- | --- | --- |
| `max_tokens` per turn | 4096 | Passed to the Messages API. |
| `max_tool_iterations` | 50 | Adapter aborts the task with `MAX_ITERATIONS`. |
| `max_usd_per_task` | $0.50 | Adapter aborts with `BUDGET_EXCEEDED` from `response.usage`. |

**Total-spend estimate**: 10 tasks * $0.50 ceiling = $5.00 worst case.
Realistic per-task spend on `claude-sonnet-4-5` for these short
information-retrieval tasks is well under $0.10, so a full real-LLM
sweep should land at ~$1 in practice.

## Task set

10 tasks; selection criteria committed in `tasks/README.md`. Phase 2
(separate issue) expands to 30 tasks and a multi-LLM study.

| Task | Frozen transcript? | Pending? |
| --- | --- | --- |
| `task-01-example-com-title` | yes | no |
| `task-02-mdn-fetch-syntax` | no | yes |
| `task-03-wikipedia-eiffel-height` | no | yes |
| `task-04-rfc-9110-section-9-title` | yes | no |
| `task-05-w3c-html-section-definition` | no | yes |
| `task-06-arxiv-2401-13919-abstract` | no | yes |
| `task-07-rust-string-trim-method` | no | yes |
| `task-08-mdn-array-map-return` | no | yes |
| `task-09-wikipedia-speed-of-light` | no | yes |
| `task-10-tc39-ecma262-strict-mode` | yes | no |

`pending: true` tasks are skipped by the mock runner. The follow-up PR
records the remaining 7 transcripts and flips the flag.

## Current coverage

**3 of 10 transcripts are frozen** in this PR; the remaining **7 are
pending** and recorded in a follow-up issue. Frozen / pending split:

- **Frozen** (must pass in mock mode): `task-01-example-com-title`,
  `task-04-rfc-9110-section-9-title`, `task-10-tc39-ecma262-strict-mode`.
- **Pending** (skipped by the mock runner, counted as `pending` in the
  report): task-02, task-03, task-05, task-06, task-07, task-08, task-09.

### Partial-gate semantics

The baseline gate is intentionally *partial* during the bootstrap phase:
the runner exits zero when every task listed in
`baseline.transcripts_required` passes, even if other tasks are still
`pending`. This lets the harness ship green at 3/10 frozen without
pretending we've verified the full ten-task contract. The runner refuses
to exit zero if **every** task is pending (that would be a 0/0 "green"
report), and the printed score string is formatted
`<passed> passed / <required> required / <total> total (<pending> pending)`
so a reader cannot mistake "3/3 = 100%" for full-suite coverage. The
follow-up PR that records the remaining transcripts will flip them out
of `pending` and grow `transcripts_required` to all ten.

## Baseline gate

`baseline.json` lists `transcripts_required` — every task in that list
**must** pass in mock mode for the runner to exit zero. A single
`replay_drift` or contract failure fails CI. `expected_pass_count`
encodes the goal state (10) so the gate cannot quietly accept a
regressed score.

## Recording a transcript (follow-up workflow)

1. Build `dist/` (`npm run build`).
2. Set `ANTHROPIC_API_KEY` and `OPENCHROME_BENCH_REAL=1`.
3. Run the claude adapter with the target task: `npm run bench:webvoyager:real -- --task <name>`.
4. Capture the final page state and the per-step tool-call `args` plus digests into
   `transcripts/<name>.jsonl`.
5. Flip `pending: false` on the task spec and add the task name to
   `baseline.json` `transcripts_required`.
6. PR title must include `[transcript-rerecord: <task names>]`.

## Comparison

| Source | Score | Median wall-time per task |
| --- | --- | --- |
| notte open-operator-evals (WebVoyager30) | 86.2% self-eval / 79.0% LLM-eval | 47s |
| OpenChrome (this benchmark) | **contract-eval** — fill in after Phase-1 real-LLM sweep | TBD |

Contract-eval is strictly more rigorous than LLM-judge eval (no 7%p
self-vs-LLM gap); the numbers are not directly comparable to notte's
86.2% — they're comparable to each other only across openchrome
releases.

## Reproducibility check

```bash
npm run bench:webvoyager:mock > /tmp/run1.json
npm run bench:webvoyager:mock > /tmp/run2.json
# Strip volatile fields (timestamp, per-task duration_ms) and diff.
diff \
  <(jq -S 'del(.timestamp, .tasks[].duration_ms)' tests/benchmark/webvoyager/reports/latest.json) \
  <(jq -S 'del(.timestamp, .tasks[].duration_ms)' tests/benchmark/webvoyager/reports/latest.json)
```

Pass = empty diff after timestamp/duration normalization.
