<p align="center">
  <img src="assets/mascot.png?v=4" alt="OpenChrome Raptor" width="180">
</p>

<h1 align="center">OpenChrome</h1>

<p align="center">
  <b>Smart. Fast. Parallel.</b><br>
  Browser automation MCP server that uses your real Chrome.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openchrome-mcp"><img src="https://img.shields.io/npm/v/openchrome-mcp" alt="npm"></a>
  <a href="https://github.com/shaun0927/openchrome/releases/latest"><img src="https://img.shields.io/github/v/release/shaun0927/openchrome" alt="Latest Release"></a>
  <a href="https://github.com/shaun0927/openchrome/releases/latest"><img src="https://img.shields.io/github/release-date/shaun0927/openchrome" alt="Release Date"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT"></a>
</p>

<p align="center">
  <img src="assets/demo.svg" alt="Traditional vs OpenChrome" width="100%">
</p>

---

## What is OpenChrome?

Imagine **20+ parallel Playwright sessions** — but already logged in to everything, invisible to bot detection, and sharing one Chrome process at 300MB. That's OpenChrome.

Search across 20 sites simultaneously. Crawl authenticated dashboards in seconds. Debug production UIs with real user sessions. Connect to [OpenClaw](https://github.com/openclaw/openclaw) and give your AI agent browser superpowers across Telegram, Discord, or any chat platform.

```
You: oc compare "AirPods Pro" prices across Amazon, eBay, Walmart,
     Best Buy, Target, Costco, B&H, Newegg — find the lowest

AI:  [8 parallel workers, all sites simultaneously]
     Best Buy:  $179 ← lowest (sale)
     Amazon:    $189
     Costco:    $194 (members)
     ...
     Time: 2.8s | All prices from live pages, already logged in.
```

| | Traditional | OpenChrome |
|---|:---:|:---:|
| **5-site task** | ~250s (login each) | **~3s** (parallel) |
| **Memory** | ~2.5 GB (5 browsers) | **~300 MB** (1 Chrome) |
| **Auth** | Every time | **Never** |
| **Bot detection** | Flagged | **Invisible** |

---

## Guided, Not Guessing

The bottleneck in browser automation isn't the browser — it's the **LLM thinking between each step**. Every tool call costs 5–15 seconds of inference time. When an AI agent guesses wrong, it doesn't just fail — it spends another 10 seconds thinking about why, then another 10 seconds trying something else.

```
Playwright agent checking prices on 5 sites:

  Site 1:  launch browser           3s
           navigate                  2s
           ⚡ bot detection          LLM thinks... 12s → retry with UA
           ⚡ CAPTCHA                LLM thinks... 10s → stuck, skip
           navigate to login         2s
           ⚡ no session             LLM thinks... 12s → fill credentials
           2FA prompt               LLM thinks... 10s → stuck
           ...
           finally reaches product   after ~20 LLM calls, ~4 minutes

  × 5 sites, sequential  =  ~100 LLM calls,  ~20 minutes,  ~$2.00

  Actual work: 5 calls.  Wasted on wandering: 95 calls.
```

OpenChrome eliminates this entirely — your Chrome is already logged in, and the hint engine corrects mistakes before they cascade:

```
OpenChrome agent checking prices on 5 sites:

  All 5 sites in parallel:
    navigate (already authenticated)     1s
    read prices                          2s
    ⚡ stale ref on one site
      └─ Hint: "Use read_page for fresh refs"    ← no guessing
    read_page → done                     1s

  = ~20 LLM calls,  ~15 seconds,  ~$0.40
```

The hint engine watches every tool call across 6 layers — error recovery, composite suggestions, repetition detection, sequence detection, learned patterns, and success guidance. When it sees the same error→recovery pattern 3+ times, it promotes it to a permanent rule across sessions.

| | Playwright | OpenChrome | Savings |
|---|---|---|---|
| **LLM calls** | ~100 | ~20 | **80% fewer** |
| **Wall time** | ~20 min | ~15 sec | **80x faster** |
| **Token cost** | ~$2.00 | ~$0.40 | **5x cheaper** |
| **Wasted calls** | ~95% | ~0% | |

---

## Quick Start

```bash
npx openchrome-mcp setup
```

That's it. Say `oc` to your AI agent.

<details>
<summary>Manual config</summary>

**Claude Code:**
```bash
claude mcp add openchrome -- npx -y openchrome-mcp serve --auto-launch
```

**VS Code / Copilot** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "openchrome": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openchrome-mcp", "serve", "--auto-launch"]
    }
  }
}
```

**Cursor / Windsurf / Other MCP clients:**
```json
{
  "mcpServers": {
    "openchrome": {
      "command": "npx",
      "args": ["-y", "openchrome-mcp", "serve", "--auto-launch"]
    }
  }
}
```

</details>

---

## Examples

**Parallel monitoring:**
```
oc screenshot AWS billing, GCP console, Stripe, and Datadog — all at once
→ 4 workers, 3.1s, already authenticated everywhere
```

**Multi-account:**
```
oc check orders on personal and business Amazon accounts simultaneously
→ 2 workers, isolated sessions, same site different accounts
```

**Competitive intelligence:**
```
oc compare prices for "AirPods Pro" across Amazon, eBay, Walmart, Best Buy
→ 4 workers, 4 sites, 2.4s, works past bot detection
```

---

## 47 Tools

| Category | Tools |
|----------|-------|
| **Navigate & Interact** | `navigate`, `click_element`, `fill_form`, `wait_and_click`, `find`, `computer` |
| **Read & Extract** | `read_page`, `page_content`, `javascript_tool`, `selector_query`, `xpath_query` |
| **Environment** | `emulate_device`, `geolocation`, `user_agent`, `network` |
| **Storage & Debug** | `cookies`, `storage`, `console_capture`, `performance_metrics`, `request_intercept` |
| **Parallel Workflows** | `workflow_init`, `workflow_collect`, `worker_create`, `batch_execute` |
| **Memory** | `memory_record`, `memory_query`, `memory_validate` |

<details>
<summary>Full tool list (47)</summary>

`navigate` `computer` `read_page` `find` `click_element` `wait_and_click` `form_input` `fill_form` `javascript_tool` `page_reload` `page_content` `page_pdf` `wait_for` `user_agent` `geolocation` `emulate_device` `network` `selector_query` `xpath_query` `cookies` `storage` `console_capture` `performance_metrics` `request_intercept` `drag_drop` `file_upload` `http_auth` `worker_create` `worker_list` `worker_update` `worker_complete` `worker_delete` `tabs_create_mcp` `tabs_context_mcp` `tabs_close` `workflow_init` `workflow_status` `workflow_collect` `workflow_collect_partial` `workflow_cleanup` `execute_plan` `batch_execute` `lightweight_scroll` `memory_record` `memory_query` `memory_validate` `oc_stop`

</details>

---

## CLI

```bash
oc setup                    # Auto-configure
oc serve --auto-launch      # Start server
oc serve --headless-shell   # Headless mode
oc doctor                   # Diagnose issues
```

---

## Cross-Platform

| Platform | Status |
|----------|--------|
| **macOS** | Full support |
| **Windows** | Full support (taskkill process cleanup) |
| **Linux** | Full support (Snap paths, `CHROME_PATH` env, `--no-sandbox` for CI) |

---

## DOM Mode (Token Efficient)

`read_page` supports three output modes:

| Mode | Output | Tokens | Use Case |
|------|--------|--------|----------|
| `ax` (default) | Accessibility tree with `ref_N` IDs | Baseline | Screen readers, semantic analysis |
| `dom` | Compact DOM with `backendNodeId` | **~5-10x fewer** | Click, fill, extract — most tasks |
| `css` | CSS diagnostic info (variables, computed styles, framework detection) | Minimal | Debugging styles, Tailwind detection |

**DOM mode example:**
```
read_page tabId="tab1" mode="dom"

[page_stats] url: https://example.com | title: Example | scroll: 0,0 | viewport: 1920x1080

[142]<input type="search" placeholder="Search..." aria-label="Search"/>
[156]<button type="submit"/>Search
[289]<a href="/home"/>Home
[352]<h1/>Welcome to Example
```

DOM mode outputs `[backendNodeId]` as stable identifiers — they persist for the lifetime of the DOM node, unlike `ref_N` IDs which are cleared on each AX-mode `read_page` call.

---

## Stable Selectors

Action tools that accept a `ref` parameter (`form_input`, `computer`, etc.) support three identifier formats:

| Format | Example | Source |
|--------|---------|--------|
| `ref_N` | `ref_5` | From `read_page` AX mode (ephemeral) |
| Raw integer | `142` | From `read_page` DOM mode (stable) |
| `node_N` | `node_142` | Explicit prefix form (stable) |

**Backward compatible** — existing `ref_N` workflows work unchanged. DOM mode's `backendNodeId` eliminates "ref not found" errors caused by stale references.

---

## Session Persistence

Headless mode (`--headless-shell`) doesn't persist cookies across restarts. Enable storage state persistence to maintain authenticated sessions:

```bash
oc serve --persist-storage                         # Enable persistence
oc serve --persist-storage --storage-dir ./state    # Custom directory
```

Cookies and localStorage are saved atomically every 30 seconds and restored on session creation.

---

## Benchmarks

Measure token efficiency and parallel performance:

```bash
npm run benchmark                                    # AX vs DOM token efficiency (interactive)
npm run benchmark:ci                                 # AX vs DOM with JSON + regression detection
npx ts-node tests/benchmark/run-parallel.ts          # All parallel benchmark categories
```

**Parallel benchmark categories:**

| Category | What It Measures |
|----------|-----------------|
| Multi-step interaction | Form fill + click sequences across N parallel pages |
| Batch JS execution | N × `javascript_tool` vs 1 × `batch_execute` |
| Compiled plan execution | Sequential agent tool calls vs single `execute_plan` |
| Streaming collection | Blocking vs `workflow_collect_partial` |
| Init overhead | Sequential `tabs_create` vs batch `workflow_init` |
| Fault tolerance | Circuit breaker recovery speed |
| Scalability curve | Speedup efficiency at 1–50x concurrency |

---

## Development

```bash
git clone https://github.com/shaun0927/openchrome.git
cd openchrome
npm install && npm run build && npm test
```

## License

MIT
