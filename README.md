# Claude Chrome Parallel

> **Automate your actual browser—with all your logins active.**

[![GitHub release](https://img.shields.io/github/v/release/shaun0927/claude-chrome-parallel)](https://github.com/shaun0927/claude-chrome-parallel/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

No more "Detached" errors. Run **20+ Claude Code sessions in parallel**.

- ✅ **Authenticated access**: Gmail, Salesforce, LinkedIn—already logged in
- ✅ **True parallelism**: 5 sites at once, 5x faster
- ✅ **Multi-account**: Same site, different accounts, isolated sessions
- ✅ **No bot detection**: Real browser profile, not headless

**This isn't just for developers.** Any web task requiring authentication—previously impossible to automate—is now possible with natural language.

<p align="center">
  <img src="https://raw.githubusercontent.com/shaun0927/claude-chrome-parallel/main/assets/demo.svg" alt="Chrome Extension vs Claude Chrome Parallel - Animated comparison showing parallel execution" width="100%">
</p>

---

## Quick Start

```bash
# Install from GitHub (recommended)
npm install -g github:shaun0927/claude-chrome-parallel

# Automatic setup (configures MCP for Claude Code)
ccp setup

# Restart Claude Code
```

That's it! The `setup` command automatically registers the MCP server with Claude Code.

<details>
<summary>Manual setup (if automatic setup fails)</summary>

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

Or run:
```bash
claude mcp add claude-chrome-parallel -- ccp serve --auto-launch
```

Restart Claude Code.
</details>

```
You: Take a screenshot of https://github.com

Claude: [Auto-launches browser, captures screenshot]
```

---

## How It Works

The official Chrome extension crashes when running multiple Claude sessions ("Detached" error). We fixed that.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Claude Code 1 ─► Worker A ─► [Tab1] [Tab2] ─┐                            │
│                    (Google account)            │                            │
│                                                │                            │
│   Claude Code 2 ─► Worker B ─► [Tab3] [Tab4] ─┼─► Chrome (single instance) │
│                    (LinkedIn account)          │     Port 9222              │
│                                                │                            │
│   Claude Code 3 ─► Worker C ─► [Tab5] [Tab6] ─┘                            │
│                    (Amazon account)                                         │
│                                                                             │
│   ✓ Each Worker has isolated cookies/session/storage                       │
│   ✓ No more "Detached" errors with concurrent sessions                     │
│   ✓ Multiple account logins on same site simultaneously                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Independent CDP connections** per session = No shared state = No conflicts.

---

## Usage Examples

### Multiple Accounts Simultaneously

```
You: Create "google-personal" and "google-work" Workers,
     then check the inbox of each Gmail account

Claude: [Creates 2 Workers → Each accesses Gmail with isolated sessions]
        google-personal: Personal account - 3 new emails
        google-work: Work account - 7 new emails
```

### Price Comparison (Parallel)

```
You: Search for "iPhone 15" lowest price on Amazon, eBay, and Walmart simultaneously

Claude: [3 sites run in parallel]
        Amazon: $999 (1.2s)
        eBay: $945 (1.1s)
        Walmart: $979 (1.3s)
        Total time: 1.3s (vs 3.6s sequential)
```

### Parallel QA Testing

```bash
# Terminal 1
claude -p "Test myapp.com/login"

# Terminal 2 (at the same time!)
claude -p "Test myapp.com/checkout"

# Terminal 3 (at the same time!)
claude -p "Monitor myapp.com/admin"
```

---

## Core Features

<table>
<tr>
<td width="33%" valign="top">

### 🔀 Worker Isolation

Each Worker has a **completely isolated browser context**.

- Separate cookies/sessions
- Separate localStorage
- Separate login states

**Log into multiple accounts on the same site simultaneously!**

</td>
<td width="33%" valign="top">

### ⚡ Parallel Execution

Run tasks across multiple tabs/Workers **at the same time**.

```
Sequential: 1500ms
  Tab1 ████░░░░ 500ms
  Tab2     ████░░░░ 500ms
  Tab3         ████░░░░ 500ms

Parallel: 500ms
  Tab1 ████░░░░
  Tab2 ████░░░░
  Tab3 ████░░░░
```

</td>
<td width="33%" valign="top">

### 🔄 Workflow Orchestration

**Automatically distribute** complex multi-site tasks.

```
workflow_init({
  workers: [
    {name: "amazon", ...},
    {name: "ebay", ...},
    {name: "walmart", ...}
  ]
})
→ 3 sites run in parallel
→ Results auto-collected
```

</td>
</tr>
</table>

---

## Chrome-Sisyphus: Orchestration Skill

For complex multi-site workflows, use the built-in **Chrome-Sisyphus** skill system.

```
┌─────────────────────────────────────────────────────────────────┐
│  /chrome-sisyphus "Compare iPhone prices on Amazon, eBay, Walmart"
│                              ↓
│  ┌──────────────────────────────────────────────────────────┐
│  │            ORCHESTRATOR (Main Session)                   │
│  │  • Decompose task → 3 workers                           │
│  │  • Allocate sites → Amazon, eBay, Walmart               │
│  │  • Context usage: ~500 tokens (lightweight!)            │
│  └──────────────────────────────────────────────────────────┘
│                              ↓
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  │  Worker 1   │  │  Worker 2   │  │  Worker 3   │
│  │  (Amazon)   │  │  (eBay)     │  │  (Walmart)  │
│  │  Background │  │  Background │  │  Background │
│  │  Task       │  │  Task       │  │  Task       │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
│         ↓                ↓                ↓
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  │ Scratchpad  │  │ Scratchpad  │  │ Scratchpad  │
│  │ worker-1.md │  │ worker-2.md │  │ worker-3.md │
│  └─────────────┘  └─────────────┘  └─────────────┘
│                              ↓
│  Results collected → Unified report to user
└─────────────────────────────────────────────────────────────────┘
```

### Context Isolation

**Without isolation** (traditional approach):
```
Main Session Context:
├── Worker 1 screenshot (500KB)     ─┐
├── Worker 1 DOM tree (large)        │
├── Worker 2 screenshot (500KB)      ├─► Context explosion!
├── Worker 2 DOM tree (large)        │
└── Worker 3 ... (keeps growing)    ─┘
```

**With Chrome-Sisyphus**:
```
Main Session: ~500 tokens (stays light)
├── Task plan
├── Worker IDs
└── Status summary only

Background Tasks: (isolated, don't pollute main)
├── Worker 1: own context, own screenshots
├── Worker 2: own context, own screenshots
└── Worker 3: own context, own screenshots
```

### Setup

```bash
cp -r node_modules/claude-chrome-parallel/.claude ~/.claude/
```

Then use:

```
/chrome-sisyphus Compare laptop prices on Amazon, BestBuy, and Newegg
```

---

## Comparison

| | Chrome Extension | Claude Chrome Parallel |
|---|:---:|:---:|
| **Concurrent Sessions** | ❌ 1 (Detached error) | ✅ **20+** |
| **Worker Isolation** | ❌ | ✅ Isolated cookies/sessions |
| **Multi-account Login** | ❌ | ✅ |
| **Parallel Execution** | ❌ | ✅ |
| **Device Emulation** | ❌ | ✅ iPhone, iPad, Pixel, etc. |
| **Geolocation Override** | ❌ | ✅ Preset cities + custom |
| **Network Simulation** | ❌ | ✅ 3G/4G/offline |
| **Performance Metrics** | ❌ | ✅ FCP, load time, heap |
| **Request Interception** | ❌ | ✅ Block ads/images/trackers |
| **PDF Generation** | ❌ | ✅ A4, Letter, landscape |
| **Console Capture** | ❌ | ✅ With filtering |
| **Workflow Orchestration** | ❌ | ✅ |
| **Auto Chrome Launch** | ❌ | ✅ |

---

## MCP Tools

### Browser Automation

| Tool | Description |
|------|-------------|
| `navigate` | Go to URL, back/forward |
| `computer` | Screenshot, click, keyboard, scroll |
| `read_page` | Parse page structure (accessibility tree) |
| `find` | Find elements by natural language |
| `form_input` | Set form values directly |
| `javascript_tool` | Execute JavaScript |

### Browser Environment

| Tool | Description |
|------|-------------|
| `user_agent` | Set User-Agent (presets: chrome, safari, googlebot, etc.) |
| `geolocation` | Override geolocation (presets: seoul, tokyo, new-york, etc.) |
| `emulate_device` | Device emulation (iphone-14, ipad-pro, pixel-7, etc.) |
| `network` | Simulate network conditions (3G, 4G, offline) |

### Page Operations

| Tool | Description |
|------|-------------|
| `page_reload` | Reload page (optional cache bypass) |
| `page_content` | Get HTML content from page or element |
| `page_pdf` | Generate PDF from page (A4, Letter, landscape, etc.) |
| `wait_for` | Wait for selector, navigation, function, or timeout |

### DOM Queries

| Tool | Description |
|------|-------------|
| `selector_query` | Query elements by CSS selector |
| `xpath_query` | Query elements by XPath expression |

### Storage & Cookies

| Tool | Description |
|------|-------------|
| `cookies` | Get/set/delete browser cookies |
| `storage` | Manage localStorage/sessionStorage |

### Debugging & Testing

| Tool | Description |
|------|-------------|
| `console_capture` | Capture console logs (with type filtering) |
| `performance_metrics` | Get performance metrics (FCP, load time, JS heap, etc.) |
| `request_intercept` | Intercept/block/log network requests |

### Advanced Interactions

| Tool | Description |
|------|-------------|
| `drag_drop` | Drag and drop by selector or coordinates |
| `file_upload` | Upload files to file input elements |
| `http_auth` | Set HTTP Basic Authentication credentials |

### Worker & Tab Management

| Tool | Description |
|------|-------------|
| `worker_create` | Create isolated browser context |
| `worker_list` | List Workers and their tabs |
| `worker_delete` | Delete Worker |
| `tabs_create_mcp` | Create new tab |
| `tabs_context_mcp` | Get tab info |
| `tabs_close` | Close tabs by ID or worker |

### Workflow Orchestration

| Tool | Description |
|------|-------------|
| `workflow_init` | Initialize parallel workflow |
| `workflow_status` | Check progress |
| `workflow_collect` | Collect results |
| `workflow_cleanup` | Clean up resources |
| `worker_update` | Update worker progress |
| `worker_complete` | Mark worker as complete |

---

## CLI Commands

```bash
ccp setup              # Auto-configure MCP for Claude Code (run this first!)
ccp serve              # Start MCP server (auto-run by Claude Code)
ccp doctor             # Diagnose installation
ccp status             # View session status
ccp cleanup            # Clean up old sessions
```

---

## Use Cases

- **Business**: ERP/SaaS data extraction, invoice downloads, repetitive task automation
- **Research**: Login-required platform data collection, academic DB searches
- **Social Media**: Multi-account posting, message management, analytics
- **E-commerce**: Member price monitoring, inventory management, review responses
- **QA Testing**: Parallel scenario testing, network condition testing
- **Productivity**: Email organization, calendar management, bookmark management

---

## Troubleshooting

### Chrome not connecting

```bash
ccp check
# Or manually start Chrome
chrome --remote-debugging-port=9222
```

### Tools not appearing in Claude Code

1. Check `~/.claude.json` configuration
2. Restart Claude Code
3. Run `/mcp` to verify `chrome-parallel` is listed

---

## Development

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel
npm install
npm run build
npm test
```

---

## License

MIT License - [LICENSE](LICENSE)

---

## Disclaimer

> **This is an unofficial community project.**
> Not affiliated with Anthropic.
>
> "Claude" is a trademark of Anthropic.

## Acknowledgments

- [Anthropic](https://anthropic.com) - Claude and MCP protocol
- [Puppeteer](https://pptr.dev/) - Browser automation
