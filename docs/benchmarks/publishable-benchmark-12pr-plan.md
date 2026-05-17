# Publishable benchmark implementation plan: 12 PRs

This plan turns OpenChrome's diagnostic benchmark harness into a publishable live/recorded-real competitive benchmark system. Each PR must preserve the diagnostic/headline boundary and fail closed when credentials or runtimes are missing.

## PR1 — Chrome launcher + runtime preflight expansion
Acceptance criteria:
- Provide a benchmark-owned Chrome launch helper with explicit profile dir, remote-debugging port, readiness probe, and cleanup.
- Runtime preflight can either check an existing CDP endpoint or launch a managed Chrome when requested.
- CI tests use injected process/probe seams; no real Chrome dependency.

## PR2 — LLM provider abstraction
Acceptance criteria:
- Define vendor-neutral provider, turn result, tool call, and usage interfaces.
- Normalize Anthropic/OpenAI token usage and stop reasons.
- Keep API keys out of logs and result artifacts.

## PR3 — Anthropic tool-use loop
Acceptance criteria:
- Implement Messages API tool-use loop behind `ANTHROPIC_API_KEY` and explicit live flag.
- Dispatch normalized tool calls to benchmark adapters.
- Enforce max tokens, max iterations, USD caps, and record artifacts.

## PR4 — OpenAI tool-use loop
Acceptance criteria:
- Implement OpenAI Responses/Chat tool loop behind `OPENAI_API_KEY` and explicit live flag.
- Use the same provider abstraction and budget accounting as Anthropic.
- Preserve deterministic injected tests.

## PR5 — Live real-world episode runner
Acceptance criteria:
- Run `library × task × repetition` real-world episodes through a chosen provider and browser adapter.
- Evaluate final postconditions, classify failure, and write live/recorded-real artifacts.
- Never promote rows without claim eligibility.

## PR6 — playwright-mcp native loop
Acceptance criteria:
- Drive `@playwright/mcp` native tools, not just passive translated calls.
- Capture tool list, tool trace, task result, and explicit unsupported/failure reasons.

## PR7 — browser-use native loop
Acceptance criteria:
- Extend Python bridge to run task-level browser-use agent instructions.
- Return final answer, trace, failure category, timeout, and postcondition evidence.

## PR8 — Live token extractor wiring
Acceptance criteria:
- Wire OpenChrome read_page/AX, Playwright accessibility, playwright-mcp snapshot, and browser-use DOM payloads.
- Keep recorded payload fallback distinct from live payloads.

## PR9 — Live throughput executor
Acceptance criteria:
- Use managed/existing Chrome CDP to run OpenChrome, Playwright, Puppeteer live throughput rows.
- Record cold/reuse session mode, concurrency, retries, and failure classification.

## PR10 — Fault injection inside episodes
Acceptance criteria:
- Add fault plan schema and episode hooks for selector drift, network stall, target closed, delayed DOM, and CDP disconnect.
- Reliability primary metric derives from final task postcondition after fault injection.

## PR11 — Recording corpus schema/validator
Acceptance criteria:
- Validate manifest, run files, version pins, LLM settings, redaction status, and final postcondition evidence.
- Provide CLI to validate corpus before report generation.

## PR12 — Headline report enforcement
Acceptance criteria:
- All live/recorded-real report paths require claimEligibility metadata.
- `--require-headline` fails if sample thresholds, version pins, LLM pins, or postcondition evidence are missing.
- Unified report separates diagnostic and headline evidence.
