# OpenChrome Validation Experiment Plan

## Overview

7 experiments to validate harness engineering claims with reproducible methodology.

## Experiment 1: Token Efficiency Benchmark

- **Claim**: 15x token compression via DOM serializer
- **Methodology**:
  - Select top 50 websites by Alexa rank across categories (news, e-commerce, SaaS, social)
  - For each site: measure raw HTML tokens vs `read_page` DOM mode tokens
  - Use cl100k_base tokenizer (GPT-4/Claude compatible)
  - Measure: compression ratio, interactive element preservation rate, information loss
- **Automation**: Script using existing benchmark infrastructure (`tests/benchmark/`)
  - `npm run benchmark:ci` already measures AX vs DOM
  - Extend to include raw HTML baseline
- **Success Criteria**:
  - Mean compression ratio >= 10x
  - Interactive element preservation = 100%
  - No actionable information lost
- **Estimated Effort**: 2-3 days

## Experiment 2: Agent Task Completion Rate (WebVoyager-style)

- **Claim**: Harness engineering increases task success rate by 15-25%
- **Methodology**:
  - Select 50 tasks from WebVoyager/Mind2Web benchmark suites
  - Categories: navigation, form filling, data extraction, multi-step workflows
  - Run each task 3x with OpenChrome, 3x with Playwright MCP (same LLM, same prompts)
  - Use Claude Sonnet as the agent LLM for consistency
  - Measure: success rate, tool call count, token consumption, wall time, cost
- **Control Variables**: Same LLM, same system prompt (minus tool-specific parts), same network
- **Automation**:
  - Create `tests/experiments/agent-benchmark/` with task definitions
  - Each task = JSON: {url, goal, success_criteria, max_steps}
  - Runner script that executes via MCP client
- **Success Criteria**:
  - OpenChrome success rate >= 75% (vs Playwright ~55-60%)
  - Tool calls reduced by >= 50%
  - Token cost reduced by >= 40%
- **Estimated Effort**: 1-2 weeks

## Experiment 3: Hint Engine Effectiveness (A/B)

- **Claim**: Hint engine reduces stuck episodes by 70%+ and saves 40-60% tokens
- **Methodology**:
  - Select 30 tasks that historically trigger hint rules (stale refs, auth redirects, CAPTCHAs, loops)
  - A group: full hint engine enabled (default)
  - B group: hint engine disabled (env var OPENCHROME_DISABLE_HINTS=true)
  - Each task run 5x per group = 300 total runs
  - Measure: stuck episodes (defined as 5+ consecutive non-progress calls), recovery time, total tokens, total tool calls
- **Automation**:
  - Add `OPENCHROME_DISABLE_HINTS` env var to hint engine (if not exists)
  - Script runs tasks in both modes, collects journal data
  - Parse journals for stuck detection using progress-tracker logic
- **Success Criteria**:
  - Stuck episodes reduced >= 60%
  - Token savings >= 30%
  - No regression in success rate
- **Estimated Effort**: 1 week

## Experiment 4: Resilience Under Failure (Chaos Engineering)

- **Claim**: 49 reliability mechanisms ensure automatic recovery with <5s downtime
- **Methodology**:
  - 6 failure injection scenarios:
    1. Chrome process kill (SIGKILL) during tool execution
    2. Network disconnect (block port 9222) for 10s
    3. Frozen renderer (inject infinite loop via page.evaluate)
    4. Memory pressure (allocate large ArrayBuffers until <500MB free)
    5. Sleep/wake simulation (pause Node process for 30s)
    6. Rapid sequential disconnects (3 kills in 60s)
  - For each: measure recovery time, data loss, tool call success after recovery
  - Run 10x per scenario = 60 total runs
- **Automation**:
  - Create `tests/experiments/chaos/` with injection scripts
  - Use existing self-healing test patterns from `tests/src/cdp-active-probe.test.ts`
  - Each scenario: start task -> inject failure -> measure recovery -> verify continuation
- **Success Criteria**:
  - Recovery rate >= 95% (all scenarios)
  - Mean recovery time < 5s
  - Zero data loss (journals, checkpoints preserved)
  - No permanent hang (every failure exits within 30s)
- **Estimated Effort**: 1 week

## Experiment 5: Stealth Effectiveness

- **Claim**: OpenChrome is invisible to bot detection
- **Methodology**:
  - Test against 5 detection systems:
    1. Cloudflare Turnstile (managed challenge)
    2. creep.js fingerprint analysis
    3. bot.sannysoft.com detection suite
    4. browserscan.net automation detection
    5. abrahamjuliot.github.io/creepjs/ (advanced fingerprinting)
  - Compare 4 configurations:
    - A. OpenChrome with stealth navigation (default)
    - B. OpenChrome without stealth (--no-stealth)
    - C. Standard puppeteer-core (headful)
    - D. Playwright (headful)
  - Measure: pass/fail per detection test, detection signals exposed count
- **Automation**:
  - Create `tests/experiments/stealth/` with detection site URLs and pass criteria
  - Screenshot + DOM analysis to determine pass/fail
  - Run 5x per configuration per site = 100 total runs
- **Success Criteria**:
  - OpenChrome stealth: >= 90% pass rate
  - Standard puppeteer: <= 50% pass rate (baseline)
  - OpenChrome non-stealth: 60-80% (shows stealth adds value)
- **Estimated Effort**: 3-5 days

## Experiment 6: Memory & Scalability

- **Claim**: 1 Chrome process with 20 tabs uses ~300MB vs ~5GB for 20 Playwright instances
- **Methodology**:
  - Scale test: N = 1, 5, 10, 20, 30, 50 tabs
  - For each N:
    - OpenChrome: open N tabs to different sites, measure total RSS
    - Playwright: launch N browser contexts, measure total RSS
  - Sites: mix of simple (example.com) and heavy (gmail.com-level complexity)
  - Measure: peak RSS, per-tab incremental memory, GC pressure, startup time
  - Run on macOS (16GB) and Linux (Docker, 8GB limit)
- **Automation**:
  - Extend existing `tests/benchmark/run-parallel.ts`
  - Use `process.memoryUsage()` for Node.js and `ps` for Chrome RSS
  - Automated data collection to CSV
- **Success Criteria**:
  - OpenChrome @ 20 tabs: < 600MB total (Chrome + Node.js)
  - Playwright @ 20 instances: > 3GB total
  - Per-tab marginal cost: OpenChrome < 15MB, Playwright > 100MB
  - Linear scaling up to 50 tabs
- **Estimated Effort**: 3-5 days

## Experiment 7: Cross-Session Learning

- **Claim**: Pattern Learner and Domain Memory improve performance across sessions
- **Methodology**:
  - Select 5 domains with known interaction difficulties
  - Run 10 sequential sessions per domain (same task, fresh MCP session each time)
  - Session 1: clean domain memory (baseline)
  - Sessions 2-10: accumulated domain memory + learned patterns
  - Measure per session: tool call count, failure count, time to completion, pattern learner promotions
- **Automation**:
  - Create `tests/experiments/learning/` with domain task definitions
  - Script that runs N sessions, preserving `~/.openchrome/memory/` between sessions
  - Parse journals for per-session metrics
- **Success Criteria**:
  - Session 5 vs Session 1: >= 20% fewer tool calls
  - Session 10 vs Session 1: >= 30% fewer failures
  - At least 3 patterns promoted to learned rules per domain
  - No degradation (learned patterns don't cause new failures)
- **Estimated Effort**: 1 week

## Execution Timeline

| Week | Experiments | Dependencies |
|------|-------------|--------------|
| 1 | Exp 1 (Token), Exp 6 (Memory) | Existing benchmark infra |
| 2 | Exp 5 (Stealth), Exp 3 (Hints) | OPENCHROME_DISABLE_HINTS env var |
| 3 | Exp 4 (Chaos) | Chaos injection scripts |
| 4-5 | Exp 2 (Agent Tasks) | Task definitions, MCP client runner |
| 5-6 | Exp 7 (Learning) | Clean memory state management |

## Infrastructure Requirements

- **Hardware**: macOS (development), Linux Docker (CI reproducibility)
- **LLM**: Claude Sonnet 4 via API (for Exp 2, 3, 7)
- **Network**: Unrestricted (for Exp 5 stealth sites)
- **Budget**: ~$50-100 LLM API costs for agent experiments
- **CI Integration**: Results should be publishable as GitHub Actions artifacts

## Data Collection & Reporting

All experiments output:
1. Raw data as CSV/JSONL in `tests/experiments/results/`
2. Summary statistics as markdown tables
3. Comparison charts (generated via simple Node.js script or included as SVG)
4. Pass/fail determination against success criteria

Final report: `docs/experiments/RESULTS.md` with executive summary and detailed per-experiment findings.
