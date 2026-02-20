# Claude Chrome Parallel

> **Browser automation that learns from mistakes.**

[![GitHub release](https://img.shields.io/github/v/release/shaun0927/claude-chrome-parallel)](https://github.com/shaun0927/claude-chrome-parallel/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Most browser MCP tools give the LLM 30+ tools and hope for the best. CCP tells it exactly what to do next — and gets smarter every session.

- **Adaptive Guidance** — Every response includes contextual hints. Error recovery, efficiency suggestions, and patterns learned from your usage.
- **True Parallelism** — 20+ concurrent sessions with isolated Workers. No "Detached" errors.
- **Authenticated Access** — Uses your real Chrome profile. Gmail, Salesforce, LinkedIn — already logged in.

<p align="center">
  <img src="https://raw.githubusercontent.com/shaun0927/claude-chrome-parallel/main/assets/demo.svg" alt="Chrome Extension vs Claude Chrome Parallel - Animated comparison showing parallel execution" width="100%">
</p>

---

## Quick Start

```bash
npm install -g github:shaun0927/claude-chrome-parallel
ccp setup
# Restart Claude Code
```

<details>
<summary>Manual setup</summary>

Add to `~/.claude.json`:

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

---

## Adaptive Guidance

Every tool response includes an `_hint` field that guides the LLM's next action. No wasted inference cycles. No blind retry loops.

```
LLM calls click_element → Error: "ref not found"

Without Adaptive Guidance:          With Adaptive Guidance:
  → retry click_element (fail)        _hint: "Refs expire after page
  → retry click_element (fail)               changes. Use read_page
  → retry click_element (fail)               for fresh refs."
  → eventually try read_page          → calls read_page (success)
  ~40 seconds wasted                  ~3 seconds total
```

### How It Works

```
tool.handler() → result
      ↓
  HintEngine evaluates rules (first-match-wins)
      │
      ├─ Error Recovery     (priority 100) — stale refs, timeouts, null elements
      ├─ Composite Hints    (priority 200) — find+click → click_element
      ├─ Repetition Detect  (priority 250) — same-tool error streaks, A↔B loops
      ├─ Sequence Detect    (priority 300) — login pages, repeated reads
      ├─ Learned Patterns   (priority 350) — adaptive memory (see below)
      └─ Success Hints      (priority 400) — next-action guidance
      │
      ↓
  _hint injected into response
```

### Adaptive Memory

The system observes error → recovery sequences and learns from them:

```
Session 1:  click_element fails → you use read_page → click succeeds
Session 2:  same pattern observed again
Session 3:  same pattern — promoted to learned rule

Session 4+: click_element fails → _hint immediately suggests read_page
```

Learned patterns persist to `.chrome-parallel/hints/learned-patterns.json` across sessions. The more you use it, the fewer mistakes it makes.

### Example Responses

**Error with recovery hint:**
```json
{
  "content": [{"type": "text", "text": "Error: ref not found: a1b2c3"}],
  "isError": true,
  "_hint": "Hint: Refs expire after page changes. Use read_page or find for fresh refs."
}
```

**Success with next-action hint:**
```json
{
  "content": [{"type": "text", "text": "{\"action\":\"navigate\", \"title\":\"Login - App\"}"}],
  "_hint": "Hint: Login page detected. Use fill_form({fields:{...}, submit:\"Login\"}) for credentials."
}
```

---

## How It Works

```
Claude Code 1 ─► Worker A ─► [Tab1] [Tab2] ─┐
                 (Google)                     │
                                              │
Claude Code 2 ─► Worker B ─► [Tab3] [Tab4] ─┼─► Chrome (single instance)
                 (LinkedIn)                   │     Port 9222
                                              │
Claude Code 3 ─► Worker C ─► [Tab5] [Tab6] ─┘
                 (Amazon)

Each Worker: isolated cookies, storage, and login state
```

**Independent CDP connections** per session. No shared state. No conflicts.

---

## Comparison

| | Playwright MCP | Browserbase | Chrome Extension | **CCP** |
|---|:---:|:---:|:---:|:---:|
| **Adaptive Guidance** | — | — | — | **21+ rules + learning** |
| **Concurrent Sessions** | Limited | ✅ | ❌ (1) | **20+** |
| **Your Chrome Profile** | — | — | ✅ | **✅** |
| **Multi-Account Isolation** | — | ✅ | — | **✅** |
| **No Cloud Dependency** | ✅ | — | ✅ | **✅** |
| **Device Emulation** | ✅ | ✅ | — | **✅** |
| **Network Simulation** | ✅ | — | — | **✅** |
| **Workflow Orchestration** | — | — | — | **✅** |
| **Learning from Usage** | — | — | — | **✅** |

---

## Tools (36)

<details>
<summary><b>Browser Automation</b> — Core interaction tools</summary>

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
<summary><b>Browser Environment</b> — Device, network, and location</summary>

| Tool | Description |
|------|-------------|
| `user_agent` | Set User-Agent (chrome, safari, googlebot, etc.) |
| `geolocation` | Override location (seoul, tokyo, new-york, etc.) |
| `emulate_device` | Device emulation (iphone-14, ipad-pro, pixel-7, etc.) |
| `network` | Simulate network conditions (3G, 4G, offline) |

</details>

<details>
<summary><b>Page Operations</b> — Content extraction and generation</summary>

| Tool | Description |
|------|-------------|
| `page_reload` | Reload page (optional cache bypass) |
| `page_content` | Get HTML content from page or element |
| `page_pdf` | Generate PDF (A4, Letter, landscape) |
| `wait_for` | Wait for selector, navigation, function, or timeout |

</details>

<details>
<summary><b>DOM Queries</b> — Precise element targeting</summary>

| Tool | Description |
|------|-------------|
| `selector_query` | Query elements by CSS selector |
| `xpath_query` | Query elements by XPath expression |

</details>

<details>
<summary><b>Storage & Cookies</b></summary>

| Tool | Description |
|------|-------------|
| `cookies` | Get/set/delete browser cookies |
| `storage` | Manage localStorage/sessionStorage |

</details>

<details>
<summary><b>Debugging & Testing</b></summary>

| Tool | Description |
|------|-------------|
| `console_capture` | Capture console logs (with type filtering) |
| `performance_metrics` | Performance metrics (FCP, load time, JS heap) |
| `request_intercept` | Intercept/block/log network requests |

</details>

<details>
<summary><b>Advanced Interactions</b></summary>

| Tool | Description |
|------|-------------|
| `drag_drop` | Drag and drop by selector or coordinates |
| `file_upload` | Upload files to file input elements |
| `http_auth` | Set HTTP Basic Authentication credentials |

</details>

<details>
<summary><b>Worker & Tab Management</b></summary>

| Tool | Description |
|------|-------------|
| `worker_create` | Create isolated browser context |
| `worker_list` | List Workers and their tabs |
| `worker_update` | Update worker progress |
| `worker_complete` | Mark worker as complete |
| `worker_delete` | Delete Worker |
| `tabs_create_mcp` | Create new tab |
| `tabs_context_mcp` | Get tab info |
| `tabs_close` | Close tabs by ID or worker |

</details>

<details>
<summary><b>Workflow Orchestration</b></summary>

| Tool | Description |
|------|-------------|
| `workflow_init` | Initialize parallel workflow with dedicated Workers |
| `workflow_status` | Check workflow progress |
| `workflow_collect` | Collect results from all Workers |
| `workflow_cleanup` | Clean up workflow resources |

</details>

---

## Usage Examples

### Parallel Price Comparison

```
You: Search for "iPhone 15" on Amazon, eBay, and Walmart simultaneously

Claude: [3 Workers run in parallel]
        Amazon:  $999 (1.2s)
        eBay:    $945 (1.1s)
        Walmart: $979 (1.3s)
        Total: 1.3s (vs 3.6s sequential)
```

### Multi-Account Management

```
You: Create Workers for my personal and work Gmail,
     then check both inboxes

Claude: [2 isolated Workers → each accesses Gmail independently]
        Personal: 3 new emails
        Work: 7 new emails
```

### Parallel QA Testing

```bash
# All three run simultaneously against the same app
claude -p "Test myapp.com/login"
claude -p "Test myapp.com/checkout"
claude -p "Monitor myapp.com/admin"
```

---

## CLI

```bash
ccp setup                         # Auto-configure MCP for Claude Code
ccp serve                         # Start MCP server
ccp serve --auto-launch           # Auto-launch Chrome if not running
ccp serve --headless-shell        # Use headless mode (15-30% less memory)
ccp serve --chrome-binary <path>  # Custom Chrome binary
ccp serve --user-data-dir <dir>   # Custom Chrome profile
ccp serve -p <port>               # Custom debugging port (default: 9222)
ccp doctor                        # Diagnose installation
ccp status                        # View session status
ccp cleanup                       # Clean up old sessions
```

---

<details>
<summary><b>Performance Optimizations</b></summary>

- **Memory** — Renderer process limits, JS heap caps, forced GC on tab close
- **Screenshots** — WebP format (3-5x smaller than PNG)
- **Cookie Bridge** — 30s TTL cache for auth cookie sharing (~10ms vs 2-6s)
- **Find Tool** — Batched CDP queries (~100ms vs ~400ms)
- **Headless Shell** — `--headless-shell` flag for 15-30% less memory

</details>

<details>
<summary><b>Workflow Orchestration (Chrome-Sisyphus)</b></summary>

For complex multi-site workflows, use the built-in orchestration skill:

```
/chrome-sisyphus Compare laptop prices on Amazon, BestBuy, and Newegg
```

Each Worker runs in an isolated background task with its own context, keeping the main session lightweight (~500 tokens).

Setup: `cp -r node_modules/claude-chrome-parallel/.claude ~/.claude/`

</details>

<details>
<summary><b>Recommended CLAUDE.md Configuration</b></summary>

```markdown
## Browser Tool Usage

Use browser tools ONLY when:
- User explicitly requests browser/UI interaction
- Visual verification or screenshot is needed
- No API/DB alternative exists

Prefer: Code analysis → DB queries → API calls → Browser (last resort)
```

</details>

---

## Development

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel
npm install
npm run build
npm test              # 756 tests
```

---

## License

MIT — [LICENSE](LICENSE)

---

> **Disclaimer**: This is an unofficial community project, not affiliated with Anthropic. "Claude" is a trademark of Anthropic.
