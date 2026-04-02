<p align="center">
  <img src="assets/mascot.png?v=4" alt="OpenChrome Raptor" width="180">
</p>

<h1 align="center">OpenChrome</h1>

<p align="center">
  <b>Harness-Engineered Browser Automation</b><br>
  The MCP server that guides AI agents.
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

<p align="center">
  <img src="assets/chart-tokens.svg" alt="Token Efficiency: OpenChrome vs Playwright" width="100%">
</p>

### How OpenChrome compares

|  | OpenChrome | Playwright MCP | Chrome DevTools MCP | Vercel agent-browser |
|---|:---:|:---:|:---:|:---:|
| **Architecture** | MCP → CDP (direct) | MCP → Playwright → CDP | MCP → Puppeteer → CDP | CLI → Daemon → Playwright → CDP |
| **RAM (20 parallel)** | **~300 MB** | ~5 GB+ | impractical | impractical |
| **Bot detection** | **invisible** (real Chrome) | detected (TLS fingerprint) | detected (CDP signals) | detected (local) / cloud only |
| **Chrome login reuse** | **built-in** | extension mode only | manual | manual state files |
| **LLM hang prevention** | **hint engine** (30+ rules) | none | none | error rewrite (5 patterns) |
| **Reliability mechanisms** | **49** (8-layer defense) | ~3 | ~3 | ~5 |
| **Token compression** | **15x** (DOM serializer) | none | none | none |
| **Outcome classification** | **yes** (DOM delta) | none | none | none |
| **Cross-session learning** | **yes** (domain memory) | none | none | none |
| **Circuit breaker** | **3-level** | none | none | none |
| **Shadow DOM** | **all types** (open + closed) | open only | invisible | invisible |
| **MCP native** | **yes** | yes | yes | no (CLI only) |
| **Parallel sessions** | **1 Chrome, N tabs** | N browsers | manual tabs | N daemons |

> **tl;dr** — OpenChrome talks directly to Chrome via CDP with zero middleware, reuses your real login sessions, and is the only browser MCP server with **harness engineering** — 27 intelligent subsystems that guide, protect, and optimize the AI agent at every step.

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

## Harness-Engineered, Not Just Automated

Traditional browser automation exposes raw APIs. When the AI agent fails, it's on its own — burning tokens guessing, retrying, and wandering. **Harness engineering** means the tool itself wraps intelligence around those APIs: preventing mistakes, recovering from errors, and guiding the agent toward efficient behavior.

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

The hint engine watches every tool call across 9 categories — error recovery, blocking page detection, composite suggestions, repetition detection, sequence detection, pagination detection, learned patterns, success guidance, and setup hints. When it sees the same error→recovery pattern 3+ times, it promotes it to a permanent rule across sessions via the Pattern Learner.

| | Playwright | OpenChrome | Savings |
|---|---|---|---|
| **LLM calls** | ~100 | ~20 | **80% fewer** |
| **Wall time** | ~20 min | ~15 sec | **80x faster** |
| **Token cost** | ~$2.00 | ~$0.40 | **5x cheaper** |
| **Wasted calls** | ~95% | ~0% | |

### 27 Harness Features Across 7 Categories

OpenChrome isn't just a browser API — it's an intelligent harness with 27 subsystems that work together:

| Category | Key Features | What It Does |
|----------|-------------|--------------|
| **Guidance** | Hint Engine (30+ rules, 9 types), Progress Tracker, Usage Guide | Prevents mistakes before they cascade |
| **Resilience** | Ralph Engine (7-strategy waterfall), Auto-Reconnect, Ref Self-Healing | Recovers from failures automatically |
| **Protection** | 3-Level Circuit Breaker, Rate Limiter, Domain Guard | Stops runaway token waste |
| **Feedback** | Outcome Classifier, DOM Delta, Visual Summary, Hit Detection | Reports what *actually* happened |
| **Learning** | Pattern Learner, Strategy Learner, Domain Memory | Gets smarter across sessions |
| **Optimization** | DOM Mode (15x compression), Adaptive Screenshot, Snapshot Delta | Minimizes token consumption |
| **Detection** | Auth Redirect Detection, Blocking Page, Pagination Detector | Identifies situations early |

<details>
<summary>Feature highlights</summary>

**Hint Engine** — 30+ rules across 9 categories (error recovery, blocking page detection, repetition loops, pagination, composite suggestions, sequence optimization, learned patterns, success guidance, setup hints). Escalates from `info` → `warning` → `critical` as patterns repeat. The Progress Tracker detects stuck agents within 3-5 tool calls.

**Ralph Engine** — When an interaction fails, Ralph automatically tries 7 strategies in sequence: AX tree click → CSS discovery → CDP coordinate dispatch → JS injection → Keyboard navigation → Raw CDP mouse events → Human-in-the-loop escalation. Each attempt is classified by the Outcome Classifier (SUCCESS / SILENT_CLICK / WRONG_ELEMENT).

**3-Level Circuit Breaker** — Element level (3 failures → skip, 2min reset), Page level (5 distinct failures → suggest reload), Global level (10 failures in 5min → pause all). Prevents agents from burning tokens on permanently broken elements.

**Pattern Learner** — When a hint rule misses, the learner observes the next 3 tool calls. If a different tool succeeds, it records the error→recovery correlation. After 3 occurrences at 60%+ confidence, it promotes the pattern to a permanent rule that fires in future sessions.

**DOM Mode** — Serializes the full DOM into a compact text format: strips SCRIPT/STYLE/SVG, keeps only 18 actionable attributes, deduplicates repetitive siblings, collapses nested wrapper chains. **Benchmarked: ~12K tokens vs ~180K tokens** for the same page (15x compression).

</details>

---

## Desktop App (Beta)

<p align="center">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-x64-0078d4?logo=windows" alt="Windows">
  <img src="https://img.shields.io/badge/Linux-x86__64-FCC624?logo=linux&logoColor=black" alt="Linux">
</p>

OpenChrome is also available as a **desktop app** — a one-click installer that runs the MCP server locally without requiring Node.js, npm, or any command-line setup. Designed for non-developers who want browser automation without the terminal.

> **Note:** These are unsigned builds. See [installation notes](#installation-notes) below.

### Download

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [GitHub Releases](https://github.com/shaun0927/openchrome/releases?q=desktop) |
| macOS (Intel) | [GitHub Releases](https://github.com/shaun0927/openchrome/releases?q=desktop) |
| Windows | [GitHub Releases](https://github.com/shaun0927/openchrome/releases?q=desktop) |
| Linux | [GitHub Releases](https://github.com/shaun0927/openchrome/releases?q=desktop) |

### Get Started (non-developers)

1. **Download** the installer for your platform from the [Releases](https://github.com/shaun0927/openchrome/releases?q=desktop) page.
2. **Install** — open the `.dmg` / run the `.exe` installer / make the `.AppImage` executable and launch it.
3. **Connect** — the app starts the MCP server automatically. Point your MCP client (Claude, Cursor, etc.) to the local server address shown in the app.

### Installation Notes

**macOS:** The app is not notarized. On first launch, macOS will block it. To fix:
```bash
xattr -cr /Applications/OpenChrome.app
```
Or right-click the app → Open → Open.

**Windows:** SmartScreen will show "Windows protected your PC". Click "More info" → "Run anyway".

**Linux:** No additional steps needed. Download the AppImage, make it executable (`chmod +x`), and run.

> **Note:** The desktop app and the CLI (`openchrome-mcp` on npm) are separate distributions with independent version numbers. You do not need both — use whichever fits your workflow. See [`desktop/RELEASING.md`](desktop/RELEASING.md) for the desktop release process.

---

## Quick Start

```bash
npx openchrome-mcp setup
```

One command. Configures MCP server + auto-approves tool permissions.
Restart Claude Code, then say `oc`.

<details>
<summary>Manual config</summary>

**Claude Code:**
```bash
claude mcp add openchrome -- npx -y openchrome-mcp@latest serve --auto-launch
```

**VS Code / Copilot** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "openchrome": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openchrome-mcp@latest", "serve", "--auto-launch"]
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
      "args": ["-y", "openchrome-mcp@latest", "serve", "--auto-launch"]
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

## 46 Tools

| Category | Tools |
|----------|-------|
| **Navigate & Interact** | `navigate`, `interact`, `fill_form`, `find`, `computer` |
| **Read & Extract** | `read_page`, `page_content`, `javascript_tool`, `selector_query`, `xpath_query` |
| **Environment** | `emulate_device`, `geolocation`, `user_agent`, `network` |
| **Storage & Debug** | `cookies`, `storage`, `console_capture`, `performance_metrics`, `request_intercept` |
| **Parallel Workflows** | `workflow_init`, `workflow_collect`, `worker_create`, `batch_execute` |
| **Memory** | `memory_record`, `memory_query`, `memory_validate` |

<details>
<summary>Full tool list (46)</summary>

`navigate` `interact` `computer` `read_page` `find` `form_input` `fill_form` `javascript_tool` `page_reload` `page_content` `page_pdf` `wait_for` `user_agent` `geolocation` `emulate_device` `network` `selector_query` `xpath_query` `cookies` `storage` `console_capture` `performance_metrics` `request_intercept` `drag_drop` `file_upload` `http_auth` `worker_create` `worker_list` `worker_update` `worker_complete` `worker_delete` `tabs_create` `tabs_context` `tabs_close` `workflow_init` `workflow_status` `workflow_collect` `workflow_collect_partial` `workflow_cleanup` `execute_plan` `batch_execute` `lightweight_scroll` `memory_record` `memory_query` `memory_validate` `oc_stop`

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

[142]<input type="search" placeholder="Search..." aria-label="Search"/> ★
[156]<button type="submit"/>Search ★
[289]<a href="/home"/>Home ★
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

## Anti-Bot & Turnstile Support

OpenChrome includes built-in defenses against Cloudflare Turnstile and similar anti-bot systems. See [Turnstile Guide](docs/turnstile-guide.md) for details.

### 3-Tier Auto-Fallback for CDN/WAF Blocks

When a navigation is blocked by CDN/WAF systems (Akamai, Cloudflare, etc.), OpenChrome automatically escalates through three tiers:

| Tier | Mode | What It Bypasses |
|------|------|-----------------|
| 1 | Headless Chrome | Normal navigation — works for most sites |
| 2 | Stealth + Headless | JS-level anti-bot (PerimeterX, Turnstile, basic fingerprinting) |
| 3 | **Headed Chrome** | TLS/UA-level blocking (Akamai CDN, network security filters) |

Tier 3 launches a real headed Chrome window with a genuine user-agent (`Chrome/...` instead of `HeadlessChrome/...`) and a different TLS fingerprint, bypassing binary-level detection that no JavaScript injection can fix.

**Parameters:**
- `autoFallback: false` — disable all automatic retry
- `headed: true` — skip directly to Tier 3 (headed Chrome)
- `stealth: true` — use stealth mode (Tier 2) explicitly

**Environment:** Tier 3 requires a display (macOS/Windows desktop, or Linux with `$DISPLAY`). In server/container environments without a display, Tier 3 is gracefully skipped.

### Known Limitations

- **CAPTCHA-protected sites (e.g., Reddit):** Auto-fallback correctly detects and escalates through all tiers, but sites that serve CAPTCHA challenges ("Prove your humanity") to all automated clients — regardless of headless/headed mode — require human interaction to solve. This is beyond auto-fallback's scope, which targets CDN/WAF network-level blocking (TLS fingerprint, user-agent detection), not interactive CAPTCHA challenges.

---

## Benchmarks

Measure token efficiency and parallel performance:

```bash
npm run benchmark                                    # Stub mode: AX vs DOM token efficiency (interactive)
npm run benchmark:ci                                 # Stub mode: AX vs DOM with JSON + regression detection
npm run benchmark -- --mode real                     # Real mode: actual MCP server (requires Chrome)
npx ts-node tests/benchmark/run-parallel.ts          # Stub mode: all parallel benchmark categories
npx ts-node tests/benchmark/run-parallel.ts --mode real --category batch-js --runs 1  # Real mode
npx ts-node tests/benchmark/run-parallel.ts --mode real --category realworld --runs 1  # Real-world benchmarks
```

By default, benchmarks run in **stub mode** — measuring protocol correctness and tool-call counts with mock responses. Use `--mode real` to spawn an actual MCP server subprocess and measure real performance (requires Chrome to be available).

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
| **Real-world** | Multi-site crawl, heavy JS, pipeline, scalability with public websites (`httpbin.org`, `jsonplaceholder`, `example.com`) — NOT included in `all`, requires network |

---

## Server / Headless Deployment

OpenChrome works on servers and in CI/CD pipelines without Chrome login. All 46 tools function with unauthenticated Chrome — navigation, scraping, screenshots, form filling, and parallel workflows all work in clean sessions.

### Quick start

```bash
# Single flag for optimal server defaults
openchrome serve --server-mode
```

`--server-mode` automatically sets:
- Auto-launches Chrome in headless mode
- Skips cookie bridge scanning (~5s faster per page creation)
- Optimal defaults for server environments

### What works without login

| Category | Tools |
|----------|-------|
| **Navigation & scraping** | `navigate`, `read_page`, `page_content`, `javascript_tool` |
| **Interaction** | `interact`, `fill_form`, `drag_drop`, `file_upload` |
| **Parallel workflows** | `workflow_init` with multiple workers, `batch_execute` |
| **Screenshots & PDF** | `computer(screenshot)`, `page_pdf` |
| **Network & performance** | `request_intercept`, `performance_metrics`, `console_capture` |

### Important: MCP client required

OpenChrome is an MCP server — it responds to tool calls, not standalone scripts. Server-side usage requires an MCP client (e.g., Claude API, Claude Code, or a custom MCP client) to drive it:

```
MCP Client (LLM) → stdio → OpenChrome (--server-mode) → Chrome
```

For standalone scraping scripts without an LLM, use Playwright or Puppeteer directly.

### Docker

A production-ready `Dockerfile` is included in the repository:

```bash
docker build -t openchrome .
docker run openchrome
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `CHROME_PATH` | Path to Chrome/Chromium binary (used by launcher) |
| `CHROME_BINARY` | Path to Chrome binary (used by `--chrome-binary` CLI flag) |
| `CHROME_USER_DATA_DIR` | Custom profile directory |
| `CI` | Detected automatically; adds `--no-sandbox` |
| `DOCKER` | Detected automatically; adds `--no-sandbox` |

### Individual flags

For fine-grained control, use individual flags instead of `--server-mode`:

```bash
openchrome serve \
  --auto-launch \
  --headless-shell \
  --port 9222
```

| Flag | Default | Description |
|------|---------|-------------|
| `--auto-launch` | `false` | Auto-launch Chrome if not running |
| `--headless-shell` | `false` | Use chrome-headless-shell binary |
| `--visible` | `false` | Show Chrome window (disables headless) |
| `--server-mode` | `false` | Compound flag for server deployment |

---

## Under the Hood: 8-Layer Reliability

OpenChrome has **49 distinct reliability mechanisms** across 8 defense layers — ensuring no single failure can hang the MCP server.

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 7: MCP Gateway                                       │
│  Rate limiter · Tool timeout (120s) · Error recovery hints  │
├─────────────────────────────────────────────────────────────┤
│  Layer 6: Session Management                                │
│  TTL cleanup · Memory pressure · Target reconciliation      │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: Request Queue                                     │
│  Per-session FIFO · Per-item timeout (120s)                 │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Circuit Breaker                                   │
│  Element (3 fails) · Page (5 fails) · Global (10/5min)     │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: CDP Client                                        │
│  Adaptive heartbeat · Stale target guard · Page defenses    │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Reconnection Engine                               │
│  Auto-reconnect (5 retries) · Exponential backoff · Cookie  │
│  restore · Sleep/wake detection                             │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Self-Healing                                      │
│  Chrome watchdog · Tab health monitor · Event loop monitor  │
│  Disk monitor · Health endpoint (/health, /metrics)         │
├─────────────────────────────────────────────────────────────┤
│  Layer 0: Process Lifecycle                                 │
│  Graceful shutdown · Orphan cleanup · Atomic file writes    │
└─────────────────────────────────────────────────────────────┘
```

**32 configurable timeouts** cover every operation from CDP commands (15s) to tool execution (120s) to Chrome launch (60s). Every timeout is independently tunable via `src/config/defaults.ts`.

## Element Intelligence

Finding elements by natural language instead of CSS selectors:

```
"Submit button" → normalizeQuery → parseQueryForAX → AX Tree Resolution
                                                          │
                                                     match found?
                                                     /         \
                                                   yes          no
                                                    │            │
                                              [AX result]   CSS Fallback
                                                             + Shadow DOM
                                                             + Scoring
```

- **AX-first**: Uses Chrome's accessibility tree — framework-agnostic across React, Angular, Vue, Web Components
- **Cascading filter**: 4-level deterministic priority (exact role+name → role+contains → exact name → partial)
- **3-tier Shadow DOM**: Open roots (JS) + closed roots (CDP) + user-agent roots
- **Hit detection**: After clicking, reports what was actually hit + nearest interactive element
- **i18n**: Korean role keywords built-in (`"버튼"` → button, `"링크"` → link, `"드롭다운"` → combobox)

---

## Development

```bash
git clone https://github.com/shaun0927/openchrome.git
cd openchrome
npm install && npm run build && npm test
```

## License

MIT
