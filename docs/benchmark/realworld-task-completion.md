# Complex Real-World Task Completion Benchmark

## Why this exists

Issue #1261 measures Developer Experience (DX): lines of code per task, MCP tool-schema quality, zero-shot tool selection, and error actionability. Those are useful diagnostic signals, but they do **not** answer the primary product question:

> Can an agent complete complex, realistic browser tasks more reliably with OpenChrome than with competing browser-control surfaces?

This benchmark is the primary evidence axis for that question. DX remains a supporting explanation layer: if OpenChrome succeeds more often or recovers faster, schema quality, actionable errors, and lower interaction complexity can help explain why.

## Scope

The benchmark measures end-to-end task completion under identical instructions, budgets, and evaluation contracts.

### Competitors

- OpenChrome MCP
- playwright-mcp
- Puppeteer MCP or current maintained equivalent
- browsermcp.io when a reproducible local runner is available
- raw Playwright / Puppeteer agent harnesses as framework references

### Task tiers

1. **Local deterministic fixtures** — reproducible checkout/search/cart/form/tab tasks with contract assertions.
2. **Stable public-reference tasks** — docs/spec lookup tasks with frozen expected answers and transcripts.
3. **Recovery tasks** — induced selector drift, timeout, detached element, navigation failure, and stale-tab conditions.
4. **Long-horizon tasks** — 8+ step workflows with extraction, decision, form entry, and verification.

## Metrics

Primary:

- task success rate, with contract postconditions
- first-attempt success rate
- recovery success rate after induced failures

Qualifying metrics:

- mean / p50 / p95 wall time
- tool calls / browser actions to success
- retries and no-progress loops
- token usage and cost where an LLM is involved
- failure category: planning, navigation, grounding, extraction, form entry, auth/state, timeout, infrastructure

## Controls

- Same task definitions and postcondition contracts for every library.
- Same LLM model, temperature, prompt budget, and max-step budget for LLM-driven cells.
- Same browser/channel/profile/network profile where possible.
- Local fixtures preferred for headline reproducibility; live tasks must be clearly labeled and isolated from local fixture claims.
- Mock or scaffold rows must never be reported as live competitive wins.

## Deliverables

- `tests/benchmark/run-realworld-task-completion.ts`
- `tests/benchmark/realworld-task-completion/` task definitions, scoring, and tests
- `benchmark/results/realworld-task-completion.json`
- `benchmark/results/REALWORLD-TASK-COMPLETION-REPORT.md`
- unified report section and npm script `bench:realworld`

## Relationship to #1261

#1261 should stay focused on DX. This benchmark is the missing primary performance axis. Reports should cite #1261 only as a diagnostic appendix, not as proof of real-world task performance.
