# Claude Chrome Parallel (CCP)

> **Ultrafast parallel browser MCP.**

[![GitHub release](https://img.shields.io/github/v/release/shaun0927/claude-chrome-parallel)](https://github.com/shaun0927/claude-chrome-parallel/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Automate your **actual Chrome** — with all your logins, cookies, and sessions intact. Run **20+ parallel browser sessions** from Claude Code without logging in to anything, ever again.

```
"Screenshot my AWS, Stripe, Vercel, GitHub, and Slack dashboards"

Playwright MCP (sequential, login each site):
  AWS    🔐━━━━━━━━━━━━━━ login 45s ━━━━ task
  Stripe              🔐━━━━━━━━━━━━━━ login 40s ━━━━ task
  Vercel                           🔐━━━━━━━━━━━━━━ login 50s ━━━━ task
  GitHub                                        🔐━━━━━━━━━━━━ login 35s ━━━━ task
  Slack                                                      🔐━━━━━━━━━━━━ login 40s ━━━━ task
  Total: ~250s | Memory: ~2.5 GB (5 browser instances)

CCP (parallel, zero auth):
  AWS    ━━━━ 3s ✓
  Stripe ━━━━ 3s ✓
  Vercel ━━━━ 3s ✓
  GitHub ━━━━ 3s ✓
  Slack  ━━━━ 3s ✓
  Total: ~3s  | Memory: ~300 MB (1 Chrome, shared contexts)

  80x faster. 8x less memory. Zero logins.
```

<p align="center">
  <img src="https://raw.githubusercontent.com/shaun0927/claude-chrome-parallel/main/assets/demo.svg" alt="Playwright MCP vs CCP — 5 authenticated sites comparison" width="100%">
</p>

---

## Why CCP Is Fast

This is not a speed optimization. It's a **structural change**.

```
Playwright MCP:  [blank browser] → login → task → close  (repeat per site)
CCP:             [your Chrome]   → task                   (already logged in)
```

Playwright creates a new browser per site. Each one needs: navigate → type email → type password → solve 2FA → wait for redirect. That's 30-120s per site, and it's sequential. **You're spending 95% of the time on authentication, not the actual task.**

CCP connects to your existing Chrome via CDP. You're already logged in to everything. Workers run in parallel. The speed advantage **compounds** with every site:

| Sites | Playwright MCP | CCP | Speedup |
|:-----:|:--------------:|:---:|:-------:|
| 1 | ~50s (login + task) | ~3s | **17x** |
| 3 | ~155s (sequential) | ~3s (parallel) | **50x** |
| 5 | ~250s | ~3s | **80x** |
| 10 | ~500s | ~3s | **160x** |

### Memory

Playwright spawns a **separate browser process** per session (~500MB each). Five sites = 2.5GB.

CCP uses **one Chrome** with lightweight browser contexts (like incognito windows sharing the same process). Five Workers = ~300MB total. That's **8x less memory** — and it stays flat whether you run 5 or 20 Workers.

### Bot Detection Immunity

Playwright runs headless browsers with detectable fingerprints. Cloudflare, reCAPTCHA, and anti-bot systems can flag them.

CCP uses **your actual Chrome** — real fingerprint, real cookies, real browsing history. It's indistinguishable from you clicking around manually, because it literally is your browser.

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

5 Workers ≈ 300MB, not 2.5GB.

</td>
<td width="25%" valign="top">

### Worker Isolation

Each Worker gets separate cookies, localStorage, and sessions.

**5 accounts on the same site. Simultaneously.**

</td>
</tr>
</table>

---

## Quick Start

```bash
# One command. That's it.
npx claude-chrome-parallel setup

# Restart Claude Code — just say "ccp".
```

**Updates are automatic.** The MCP server runs via `npx`, so you always get the latest version.

<details>
<summary>Manual setup</summary>

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "npx",
      "args": ["-y", "claude-chrome-parallel", "serve", "--auto-launch"]
    }
  }
}
```

Or: `claude mcp add claude-chrome-parallel -- npx -y claude-chrome-parallel serve --auto-launch`

</details>

<details>
<summary>Installation scope</summary>

```bash
npx claude-chrome-parallel setup                  # Global — all projects (default)
npx claude-chrome-parallel setup --scope project  # Project — this directory only
```

Global writes to `~/.claude.json`. Project writes to `.mcp.json` in the current directory.

</details>

---

## Just Say `ccp`

After setup, **`ccp` is your magic word.** No flags, no config, no boilerplate. Just tell Claude what you want with "ccp" and it happens.

```
You: ccp screenshot my Gmail inbox
Claude: [Already logged in. Screenshot taken. Done.]

You: ccp check my AWS billing and Stripe revenue at the same time
Claude: [2 Workers, parallel, 2.1s — both dashboards captured]

You: use ccp to compare iPhone prices on Amazon, eBay, and Walmart
Claude: [3 Workers, 3 sites, simultaneously]
        Amazon:  $999 | eBay: $945 ← lowest | Walmart: $979
```

**How it works**: CCP uses the MCP protocol's native `instructions` field to teach Claude the keyword automatically. No CLAUDE.md injection. No hooks. Just install and go.

---

## What You Can Do

### 20-Site Parallel Crawling

```
You: ccp crawl these 20 competitor sites and extract their pricing

Claude: [20 Workers, 20 sites, simultaneously — all in your logged-in Chrome]
        site-01:  $49/mo  ✓  (1.2s)
        site-02:  $59/mo  ✓  (0.9s)
        ...
        site-20:  $39/mo  ✓  (1.4s)
        Total: 2.8s | Sequential: ~60s | Speedup: 21x
```

Each Worker runs in an isolated browser context. One Chrome process, 20 parallel sessions, ~300MB total. Not 20 separate browsers eating 10GB of RAM.

### Multi-Cloud Dashboard Monitoring

```
You: ccp screenshot my AWS billing, GCP console, Azure portal, Stripe,
     and Datadog — all at once

Claude: [5 Workers — already logged into every cloud provider]
        aws-billing.png      $12,847/mo  ✓
        gcp-console.png      $8,291/mo   ✓
        azure-portal.png     $3,104/mo   ✓
        stripe-revenue.png   $47,230 MRR ✓
        datadog-metrics.png  99.7% uptime ✓
        Time: 3.1s (not 10+ minutes of login screens)
```

No OAuth tokens. No service accounts. No API keys to rotate. You're already logged in.

### Automated Regression Testing

```bash
# Full regression suite — 10 flows, 10 Workers, one command
claude -p "ccp test these 10 critical flows on staging.myapp.com:
  login, signup, checkout, search, profile-edit,
  password-reset, file-upload, notifications, admin-panel, API-docs"

# Sequential: ~15 minutes.  CCP: ~90 seconds.
# Run this before every deploy.
```

Each Worker gets an isolated session — no cookie contamination between test flows. Test multi-user scenarios (admin + regular user) simultaneously.

### Competitive Intelligence at Scale

```
You: ccp monitor pricing on Amazon, Walmart, Target, Best Buy, and Costco
     for "Sony WH-1000XM5" — compare and find the lowest

Claude: [5 Workers, 5 retailers, parallel]
        Amazon:    $278
        Walmart:   $298
        Target:    $279
        Best Buy:  $249 ← lowest (sale)
        Costco:    $269 (members only)
        Time: 2.4s | All prices from live pages, not cached APIs
```

Works on sites with bot detection because it's your real Chrome — real cookies, real fingerprint, real browsing history.

### Multi-Account Operations

```
You: ccp check order status on my personal and business Amazon accounts,
     plus my eBay seller dashboard — all at the same time

Claude: [3 Workers, 3 isolated sessions]
        Amazon Personal:  2 packages arriving tomorrow
        Amazon Business:  Purchase order #4521 approved
        eBay Seller:      3 new orders, $847 revenue today
        Time: 2.1s
```

Same site, different accounts, simultaneously. Each Worker has its own cookies and session state.

---

## Comparison

| | Playwright MCP | Browserbase | Chrome Extension | **CCP** |
|---|:---:|:---:|:---:|:---:|
| **Auth overhead per site** | ❌ 30-120s | ❌ 30-120s | ✅ 0s | **✅ 0s** |
| **5-site authenticated task** | ~250s | ~250s + cost | N/A (1 session) | **~3s** |
| **Memory (5 sessions)** | ~2.5 GB | N/A (cloud) | N/A | **~300 MB** |
| **Uses your Chrome logins** | ❌ Blank browser | ❌ Cloud browser | ✅ | **✅** |
| **Concurrent sessions** | ⚠️ Limited | ✅ (paid) | ❌ 1 (crashes) | **✅ 20+** |
| **Multi-account isolation** | ❌ | ✅ (paid) | ❌ | **✅** |
| **Runs locally** | ✅ | ❌ Cloud only | ✅ | **✅** |
| **Free** | ✅ | ❌ | ✅ | **✅** |
| **No bot detection** | ❌ Headless | ❌ Fingerprinted | ✅ | **✅** |
| **Device emulation** | ✅ | ✅ | ❌ | **✅** |
| **Network simulation** | ✅ | ❌ | ❌ | **✅** |
| **Workflow orchestration** | ❌ | ❌ | ❌ | **✅** |
| **Adaptive Guidance** | ❌ | ❌ | ❌ | **✅** |

---

## Adaptive Guidance

The biggest time sink in LLM browser automation isn't execution speed — it's **wrong tool choices, missed page state, and pointless retries**. Each mistake costs 3-10 seconds of LLM inference. Three mistakes and you've wasted 30 seconds before anything useful happens.

CCP injects contextual `_hint` fields into every tool response to prevent this:

```
click_element → Error: "ref not found"
  _hint: "Refs expire after page changes. Use read_page for fresh refs."
  → LLM self-corrects. No retry loop. No wasted tokens.

navigate → title contains "Login"
  _hint: "Login page detected. Use fill_form for credentials."
  → LLM skips straight to form filling.

find → computer(click) pattern detected
  _hint: "Use click_element to find+click in one call."
  → Eliminates unnecessary intermediate steps.
```

21 static rules across 6 priority tiers + an **adaptive memory** system that learns from your usage. When the same error→recovery pattern appears 3 times, it's promoted to a permanent hint — persisted across sessions in `.chrome-parallel/hints/learned-patterns.json`.

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
ccp setup                         # Auto-configure (global)
ccp setup --scope project         # Auto-configure (project only)
ccp serve --auto-launch           # Start with auto Chrome launch
ccp serve --headless-shell        # Headless mode (15-30% less memory)
ccp serve -p <port>               # Custom debugging port (default: 9222)
ccp doctor                        # Diagnose installation
ccp status                        # View sessions
ccp cleanup                       # Clean up old sessions
```

> `ccp` requires global install (`npm i -g claude-chrome-parallel`). All commands also work via `npx claude-chrome-parallel <command>`.

---

<details>
<summary><b>Performance Optimizations</b></summary>

- **Memory** — Renderer process limits, JS heap caps, forced GC on tab close
- **Screenshots** — WebP format (3-5x smaller than PNG)
- **Cookie Bridge** — 30s TTL cache for auth cookie sharing (~10ms vs 2-6s)
- **Find Tool** — Batched CDP queries (~100ms vs ~400ms)
- **Headless Shell** — `--headless-shell` for 15-30% less memory

</details>

---

## Development

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel
npm install && npm run build && npm test
```

## Compatibility

CCP is a standard **MCP server** (stdio JSON-RPC). While optimized for Claude Code, it works with any MCP-compatible client:

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "npx",
      "args": ["-y", "claude-chrome-parallel", "serve", "--auto-launch"]
    }
  }
}
```

Cursor, Windsurf, Codex CLI, or any editor that supports MCP can use CCP with the config above. See [Contributing](CONTRIBUTING.md) for multi-client testing status.

## License

MIT — [LICENSE](LICENSE)

---

> **Disclaimer**: Unofficial community project. Not affiliated with Anthropic. "Claude" is a trademark of Anthropic.
