# Claude Chrome Parallel

> **Your browser. 20 sessions. Zero logins.**

[![GitHub release](https://img.shields.io/github/v/release/shaun0927/claude-chrome-parallel)](https://github.com/shaun0927/claude-chrome-parallel/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Automate your **actual Chrome** — with all your logins, cookies, and sessions intact. Run **20+ parallel browser sessions** from Claude Code without logging in to anything, ever again.

<p align="center">
  <img src="https://raw.githubusercontent.com/shaun0927/claude-chrome-parallel/main/assets/demo.svg" alt="Chrome Extension vs Claude Chrome Parallel - Animated comparison showing parallel execution" width="100%">
</p>

---

## The Problem

**Playwright MCP** launches a blank browser. No cookies. No logins. You authenticate manually, every single time.

**The official Chrome Extension** connects to your browser — but crashes the moment you open a second Claude session. `"Detached"` error. Done.

**Browserbase** works, but it's cloud-hosted, paid, and your credentials leave your machine.

**Claude Chrome Parallel** uses your real Chrome profile with all your existing logins, runs 20+ sessions in parallel, and everything stays local. For free.

---

## Core Features

<table>
<tr>
<td width="33%" valign="top">

### Authenticated Access

Your actual Chrome profile. Gmail, Slack, Salesforce, LinkedIn, AWS Console — **already logged in**.

No credential management.
No OAuth flows.
No "please log in" loops.

**If you can see it in Chrome, Claude can automate it.**

</td>
<td width="33%" valign="top">

### True Parallelism

Run tasks across multiple sites **at the same time**.

```
Sequential:  12s
  Gmail    ████████░░░░ 4s
  Slack        ████████░░░░ 4s
  Jira             ████████░░░░ 4s

Parallel:    4s
  Gmail    ████████░░░░
  Slack    ████████░░░░
  Jira     ████████░░░░
```

**5 sites at once. 5x faster. Zero conflicts.**

</td>
<td width="33%" valign="top">

### Worker Isolation

Each Worker gets a **completely isolated browser context**.

- Separate cookies & sessions
- Separate localStorage
- Separate login states

**Log into the same site with 5 different accounts. Simultaneously.**

</td>
</tr>
</table>

---

## Quick Start

```bash
# Install
npm install -g github:shaun0927/claude-chrome-parallel

# Auto-configure Claude Code
ccp setup

# Restart Claude Code — done.
```

<details>
<summary>Manual setup</summary>

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "ccp",
      "args": ["serve", "--auto-launch"]
    }
  }
}
```

Or: `claude mcp add claude-chrome-parallel -- ccp serve --auto-launch`

</details>

```
You: Take a screenshot of my Gmail inbox

Claude: [Uses your Chrome — already logged in. No setup needed.]
```

---

## What You Can Do

### Multi-Account Operations

```
You: Check my personal and work Gmail inboxes at the same time

Claude: [Creates 2 isolated Workers]
        Personal account: 3 unread emails
        Work account: 7 unread emails
        Time: 2.1s (parallel)
```

### Price Comparison Across Sites

```
You: Find the cheapest iPhone 15 on Amazon, eBay, and Walmart

Claude: [3 Workers, 3 sites, simultaneously]
        Amazon:  $999
        eBay:    $945  ← lowest
        Walmart: $979
        Time: 1.3s total (not 3.9s)
```

### Authenticated Dashboard Monitoring

```
You: Screenshot my AWS billing, Stripe dashboard, and Vercel usage

Claude: [All 3 require login — but you're already authenticated]
        aws-billing.png    ✓
        stripe-revenue.png ✓
        vercel-usage.png   ✓
```

### Parallel QA Testing

```bash
# Three terminals, three tests, same app, same time
claude -p "Test login flow on myapp.com"
claude -p "Test checkout on myapp.com"
claude -p "Test admin panel on myapp.com"
```

---

## Comparison

| | Playwright MCP | Browserbase | Chrome Extension | **CCP** |
|---|:---:|:---:|:---:|:---:|
| **Uses your Chrome logins** | ❌ Blank browser | ❌ Cloud browser | ✅ | **✅** |
| **Concurrent sessions** | ⚠️ Limited | ✅ (paid) | ❌ 1 (crashes) | **✅ 20+** |
| **Multi-account isolation** | ❌ | ✅ (paid) | ❌ | **✅** |
| **Runs locally** | ✅ | ❌ Cloud only | ✅ | **✅** |
| **Free** | ✅ | ❌ | ✅ | **✅** |
| **No bot detection** | ❌ Headless | ❌ Fingerprinted | ✅ | **✅** |
| **Device emulation** | ✅ | ✅ | ❌ | **✅** |
| **Network simulation** | ✅ | ❌ | ❌ | **✅** |
| **PDF generation** | ✅ | ❌ | ❌ | **✅** |
| **Workflow orchestration** | ❌ | ❌ | ❌ | **✅** |
| **Adaptive Guidance** | ❌ | ❌ | ❌ | **✅** |

---

## Adaptive Guidance

Every tool response includes contextual hints that prevent the LLM from wasting time on wrong approaches. 21 static rules + an adaptive memory system that learns from your usage patterns.

```
click_element → Error: "ref not found"
  _hint: "Refs expire after page changes. Use read_page for fresh refs."
  → LLM self-corrects. No retry loop. No wasted tokens.

navigate → title contains "Login"
  _hint: "Login page detected. Use fill_form for credentials."
  → LLM skips straight to form filling.
```

**Adaptive Memory**: The system observes which tool resolves each error type. After seeing the same recovery pattern 3 times, it promotes it to a permanent hint — persisted across sessions in `.chrome-parallel/hints/learned-patterns.json`.

<details>
<summary>Rule priority tiers</summary>

| Tier | Priority | Examples |
|------|----------|---------|
| Error Recovery | 100 | Stale refs, tab not found, timeouts, null elements |
| Composite Hints | 200 | find+click → click_element, multiple form_input → fill_form |
| Repetition Detection | 250 | Same-tool error streaks, A↔B oscillation loops |
| Sequence Detection | 300 | Login page detection, navigate→screenshot without wait |
| Learned Patterns | 350 | Automatically discovered error→recovery correlations |
| Success Hints | 400 | Post-click navigation check, form submission verification |

</details>

---

## Tools (36)

<details>
<summary><b>Browser Automation</b> — navigate, click, type, find</summary>

| Tool | Description |
|------|-------------|
| `navigate` | Go to URL, back/forward |
| `computer` | Screenshot, click, keyboard, scroll |
| `read_page` | Parse page structure (accessibility tree) |
| `find` | Find elements by natural language |
| `click_element` | Find and click in one step |
| `wait_and_click` | Wait for element, then click |
| `form_input` | Set individual form values |
| `fill_form` | Fill multiple fields + submit in one call |
| `javascript_tool` | Execute JavaScript |

</details>

<details>
<summary><b>Browser Environment</b> — device, network, location</summary>

| Tool | Description |
|------|-------------|
| `user_agent` | Set User-Agent (chrome, safari, googlebot, etc.) |
| `geolocation` | Override location (seoul, tokyo, new-york, etc.) |
| `emulate_device` | Device emulation (iphone-14, ipad-pro, pixel-7, etc.) |
| `network` | Simulate network conditions (3G, 4G, offline) |

</details>

<details>
<summary><b>Page Operations</b> — content, PDF, reload, wait</summary>

| Tool | Description |
|------|-------------|
| `page_reload` | Reload page (optional cache bypass) |
| `page_content` | Get HTML content from page or element |
| `page_pdf` | Generate PDF (A4, Letter, landscape) |
| `wait_for` | Wait for selector, navigation, function, or timeout |

</details>

<details>
<summary><b>DOM, Storage, Debugging, Advanced</b></summary>

| Tool | Description |
|------|-------------|
| `selector_query` | Query elements by CSS selector |
| `xpath_query` | Query elements by XPath expression |
| `cookies` | Get/set/delete browser cookies |
| `storage` | Manage localStorage/sessionStorage |
| `console_capture` | Capture console logs (with type filtering) |
| `performance_metrics` | Performance metrics (FCP, load time, JS heap) |
| `request_intercept` | Intercept/block/log network requests |
| `drag_drop` | Drag and drop by selector or coordinates |
| `file_upload` | Upload files to file input elements |
| `http_auth` | Set HTTP Basic Authentication credentials |

</details>

<details>
<summary><b>Workers & Orchestration</b></summary>

| Tool | Description |
|------|-------------|
| `worker_create` | Create isolated browser context |
| `worker_list` | List Workers and their tabs |
| `worker_update` | Update worker progress |
| `worker_complete` | Mark worker as complete |
| `worker_delete` | Delete Worker |
| `tabs_create_mcp` | Create new tab |
| `tabs_context_mcp` | Get tab info |
| `tabs_close` | Close tabs |
| `workflow_init` | Initialize parallel workflow |
| `workflow_status` | Check workflow progress |
| `workflow_collect` | Collect results from all Workers |
| `workflow_cleanup` | Clean up workflow resources |

</details>

---

## CLI

```bash
ccp setup                         # Auto-configure for Claude Code
ccp serve --auto-launch           # Start with auto Chrome launch
ccp serve --headless-shell        # Headless mode (15-30% less memory)
ccp serve --chrome-binary <path>  # Custom Chrome binary
ccp serve -p <port>               # Custom debugging port (default: 9222)
ccp doctor                        # Diagnose installation
ccp status                        # View sessions
ccp cleanup                       # Clean up old sessions
```

---

<details>
<summary><b>Performance Optimizations</b></summary>

- **Memory** — Renderer process limits, JS heap caps, forced GC on tab close
- **Screenshots** — WebP format (3-5x smaller than PNG)
- **Cookie Bridge** — 30s TTL cache for auth cookie sharing (~10ms vs 2-6s)
- **Find Tool** — Batched CDP queries (~100ms vs ~400ms)
- **Headless Shell** — `--headless-shell` for 15-30% less memory

</details>

## Development

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel
npm install && npm run build && npm test  # 756 tests
```

## License

MIT — [LICENSE](LICENSE)

---

> **Disclaimer**: Unofficial community project. Not affiliated with Anthropic. "Claude" is a trademark of Anthropic.
