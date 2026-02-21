<p align="center">
  <img src="assets/mascot.png" alt="OpenChrome Raptor" width="200">
</p>

<h1 align="center">OpenChrome</h1>

<p align="center">
  <b>Open-source browser automation MCP server.</b><br>
  Control your real Chrome from any AI agent.
</p>

<p align="center">
  <a href="https://github.com/shaun0927/openchrome/releases"><img src="https://img.shields.io/github/v/release/shaun0927/openchrome" alt="GitHub release"></a>
  <a href="https://www.npmjs.com/package/openchrome"><img src="https://img.shields.io/npm/v/openchrome" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

Automate your **actual Chrome** — with all your logins, cookies, and sessions intact. Run **20+ parallel browser sessions** from any MCP-compatible AI agent without logging in to anything, ever again.

```
"Screenshot my AWS, Stripe, Vercel, GitHub, and Slack dashboards"

Traditional browser automation (sequential, login each site):
  AWS    login 45s ━━━━ task
  Stripe              login 40s ━━━━ task
  Vercel                           login 50s ━━━━ task
  GitHub                                        login 35s ━━━━ task
  Slack                                                      login 40s ━━━━ task
  Total: ~250s | Memory: ~2.5 GB (5 browser instances)

OpenChrome (parallel, zero auth):
  AWS    ━━━━ 3s done
  Stripe ━━━━ 3s done
  Vercel ━━━━ 3s done
  GitHub ━━━━ 3s done
  Slack  ━━━━ 3s done
  Total: ~3s  | Memory: ~300 MB (1 Chrome, shared contexts)

  80x faster. 8x less memory. Zero logins.
```

---

## Why OpenChrome Is Fast

This is not a speed optimization. It's a **structural change**.

```
Traditional:    [blank browser] → login → task → close  (repeat per site)
OpenChrome:     [your Chrome]   → task                   (already logged in)
```

Traditional browser automation creates a new browser per site. Each one needs: navigate, type email, type password, solve 2FA, wait for redirect. That's 30-120s per site, and it's sequential. **You're spending 95% of the time on authentication, not the actual task.**

OpenChrome connects to your existing Chrome via CDP. You're already logged in to everything. Workers run in parallel. The speed advantage **compounds** with every site:

| Sites | Traditional | OpenChrome | Speedup |
|:-----:|:-----------:|:----------:|:-------:|
| 1 | ~50s (login + task) | ~3s | **17x** |
| 3 | ~155s (sequential) | ~3s (parallel) | **50x** |
| 5 | ~250s | ~3s | **80x** |
| 10 | ~500s | ~3s | **160x** |

---

## Core Features

<table>
<tr>
<td width="25%" valign="top">

### Zero Auth

Your actual Chrome profile. Gmail, Slack, AWS, Stripe — **already logged in**.

No credentials. No OAuth. No 2FA loops.

</td>
<td width="25%" valign="top">

### 20+ Parallel Workers

All Workers run simultaneously in isolated browser contexts.

5 sites in ~3s, not ~250s.

</td>
<td width="25%" valign="top">

### 8x Less Memory

One Chrome process, shared contexts. Not N separate browser instances.

5 Workers = 300MB, not 2.5GB.

</td>
<td width="25%" valign="top">

### Any MCP Client

Works with Claude Code, VS Code Copilot, Cursor, Windsurf, Codex CLI, and any MCP-compatible agent.

</td>
</tr>
</table>

---

## Quick Start

```bash
# One command. That's it.
npx openchrome setup

# Restart your AI agent — just say "oc" or "openchrome".
```

**Updates are automatic.** The MCP server runs via `npx`, so you always get the latest version.

<details>
<summary>Manual setup (Claude Code)</summary>

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "npx",
      "args": ["-y", "openchrome", "serve", "--auto-launch"]
    }
  }
}
```

Or: `claude mcp add openchrome -- npx -y openchrome serve --auto-launch`

</details>

<details>
<summary>VS Code / Copilot</summary>

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "openchrome": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openchrome", "serve", "--auto-launch"]
    }
  }
}
```

Open Copilot Chat in **Agent** mode to use OpenChrome tools.

</details>

<details>
<summary>Cursor / Windsurf / Other MCP Clients</summary>

Add to your MCP config:

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "npx",
      "args": ["-y", "openchrome", "serve", "--auto-launch"]
    }
  }
}
```

</details>

<details>
<summary>Installation scope</summary>

```bash
npx openchrome setup                  # Global — all projects (default)
npx openchrome setup --scope project  # Project — this directory only
```

</details>

---

## Just Say `oc`

After setup, **`oc` is your magic word.** No flags, no config, no boilerplate. Just tell your AI agent what you want and it happens.

```
You: oc screenshot my Gmail inbox
AI:  [Already logged in. Screenshot taken. Done.]

You: oc check my AWS billing and Stripe revenue at the same time
AI:  [2 Workers, parallel, 2.1s — both dashboards captured]

You: use openchrome to compare iPhone prices on Amazon, eBay, and Walmart
AI:  [3 Workers, 3 sites, simultaneously]
     Amazon:  $999 | eBay: $945 (lowest) | Walmart: $979
```

**How it works**: OpenChrome uses the MCP protocol's native `instructions` field to teach AI agents the keyword automatically. No manual config injection. Just install and go.

---

## What You Can Do

### 20-Site Parallel Crawling

```
You: oc crawl these 20 competitor sites and extract their pricing

AI:  [20 Workers, 20 sites, simultaneously — all in your logged-in Chrome]
     site-01:  $49/mo  done  (1.2s)
     site-02:  $59/mo  done  (0.9s)
     ...
     site-20:  $39/mo  done  (1.4s)
     Total: 2.8s | Sequential: ~60s | Speedup: 21x
```

### Multi-Cloud Dashboard Monitoring

```
You: oc screenshot my AWS billing, GCP console, Azure portal, Stripe,
     and Datadog — all at once

AI:  [5 Workers — already logged into every cloud provider]
     aws-billing.png      $12,847/mo  done
     gcp-console.png      $8,291/mo   done
     azure-portal.png     $3,104/mo   done
     stripe-revenue.png   $47,230 MRR done
     datadog-metrics.png  99.7% uptime done
     Time: 3.1s (not 10+ minutes of login screens)
```

### Multi-Account Operations

```
You: oc check order status on my personal and business Amazon accounts,
     plus my eBay seller dashboard — all at the same time

AI:  [3 Workers, 3 isolated sessions]
     Amazon Personal:  2 packages arriving tomorrow
     Amazon Business:  Purchase order #4521 approved
     eBay Seller:      3 new orders, $847 revenue today
     Time: 2.1s
```

Same site, different accounts, simultaneously. Each Worker has its own cookies and session state.

---

## Comparison

| | Playwright MCP | Browserbase | Chrome Extension | **OpenChrome** |
|---|:---:|:---:|:---:|:---:|
| **Auth overhead per site** | 30-120s | 30-120s | 0s | **0s** |
| **5-site authenticated task** | ~250s | ~250s + cost | N/A | **~3s** |
| **Memory (5 sessions)** | ~2.5 GB | N/A (cloud) | N/A | **~300 MB** |
| **Uses your Chrome logins** | No | No | Yes | **Yes** |
| **Concurrent sessions** | Limited | Yes (paid) | 1 | **20+** |
| **Multi-account isolation** | No | Yes (paid) | No | **Yes** |
| **Any MCP client** | Yes | Yes | No | **Yes** |
| **Runs locally** | Yes | No | Yes | **Yes** |
| **Free** | Yes | No | Yes | **Yes** |
| **No bot detection** | No | No | Yes | **Yes** |
| **Adaptive Guidance** | No | No | No | **Yes** |
| **Domain Memory** | No | No | No | **Yes** |

---

## Adaptive Guidance

The biggest time sink in LLM browser automation isn't execution speed — it's **wrong tool choices, missed page state, and pointless retries**. Each mistake costs 3-10 seconds of LLM inference.

OpenChrome injects contextual `_hint` fields into every tool response to prevent this:

```
click_element → Error: "ref not found"
  _hint: "Refs expire after page changes. Use read_page for fresh refs."
  → LLM self-corrects. No retry loop. No wasted tokens.

navigate → title contains "Login"
  _hint: "Login page detected. Use fill_form for credentials."
  → LLM skips straight to form filling.
```

21 static rules across 6 priority tiers + an **adaptive memory** system that learns from your usage.

---

## Domain Memory

Workers waste 2-3 tool calls per session re-discovering selectors. OpenChrome's domain memory system eliminates this by persisting what works across sessions.

| Tool | Purpose | Example |
|------|---------|---------|
| `memory_record` | Store knowledge after success | `{domain: "x.com", key: "selector:tweet", value: "article[data-testid='tweet']"}` |
| `memory_query` | Retrieve before site interaction | `{domain: "x.com"}` → all entries sorted by confidence |
| `memory_validate` | Feedback after using knowledge | `{id: "dk-...", success: true}` → confidence +0.1 |

---

## Tools (47)

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
| `console_capture` | Capture console logs |
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
| `workflow_collect_partial` | Collect from completed Workers only |
| `workflow_cleanup` | Clean up workflow resources |
| `execute_plan` | Execute a cached workflow plan |
| `batch_execute` | Run JS across multiple tabs in parallel |
| `lightweight_scroll` | Scroll without screenshot overhead |
| `memory_record` | Store domain knowledge for reuse |
| `memory_query` | Retrieve learned knowledge for a domain |
| `memory_validate` | Report success/failure to adjust confidence |
| `ccp_stop` | Gracefully shut down the server |

</details>

---

## CLI

```bash
oc setup                         # Auto-configure (global)
oc setup --scope project         # Auto-configure (project only)
oc serve --auto-launch           # Start with auto Chrome launch
oc serve --headless-shell        # Headless mode (15-30% less memory)
oc serve -p <port>               # Custom debugging port (default: 9222)
oc doctor                        # Diagnose installation
oc status                        # View sessions
oc cleanup                       # Clean up old sessions
```

> `oc` requires global install (`npm i -g openchrome`). All commands also work via `npx openchrome <command>`.

---

## Cross-Platform Support

| Platform | Chrome Detection | Profile | Process Cleanup |
|----------|-----------------|---------|-----------------|
| **macOS** | `/Applications/Google Chrome.app/...` | `~/Library/Application Support/Google/Chrome` | `kill` |
| **Windows** | `PROGRAMFILES`, `LOCALAPPDATA` | `AppData/Local/Google/Chrome/User Data` | `taskkill /T /F` |
| **Linux** | `google-chrome-stable`, Snap paths, `CHROME_PATH` env | `~/.config/google-chrome`, `~/.config/chromium` | `kill` |
| **CI/Docker** | Auto-detect with `--no-sandbox` | Temp profile | Standard |

---

## Development

```bash
git clone https://github.com/shaun0927/openchrome.git
cd openchrome
npm install && npm run build && npm test
```

## License

MIT — [LICENSE](LICENSE)
