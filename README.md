# Claude Chrome Parallel

> **Run 20+ Claude Code browser sessions simultaneously, without conflicts.**

[![npm version](https://badge.fury.io/js/claude-chrome-parallel.svg)](https://www.npmjs.com/package/claude-chrome-parallel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Claude Code 1 ─► Worker A ─► [Tab1] [Tab2] ─┐                            │
│                    (Google account)            │                            │
│                                                │                            │
│   Claude Code 2 ─► Worker B ─► [Tab3] [Tab4] ─┼─► Chrome (single instance) │
│                    (Naver account)             │     Port 9222              │
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

## Comparison

| | Chrome Extension | Claude Chrome Parallel |
|---|:---:|:---:|
| **Concurrent Sessions** | ❌ 1 (Detached error) | ✅ **20+** |
| **Worker Isolation** | ❌ | ✅ Isolated cookies/sessions |
| **Multi-account Login** | ❌ | ✅ |
| **Parallel Execution** | ❌ | ✅ |
| **Network Simulation** | ❌ | ✅ 3G/4G/offline |
| **Workflow Orchestration** | ❌ | ✅ |
| **Auto Chrome Launch** | ❌ | ✅ |

---

## Quick Start (2 minutes)

### 1. Install

```bash
npm install -g claude-chrome-parallel
```

### 2. Configure Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "ccp",
      "args": ["serve"]
    }
  }
}
```

### 3. Restart Claude Code and use

```
You: Take a screenshot of https://github.com

Claude: [Auto-launches browser, captures screenshot]
```

> **Tip:** `ccp` is a shorthand for `claude-chrome-parallel`.

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
| `network` | Simulate network conditions |

### Worker & Tab Management

| Tool | Description |
|------|-------------|
| `worker_create` | Create isolated browser context |
| `worker_list` | List Workers and their tabs |
| `worker_delete` | Delete Worker |
| `tabs_create_mcp` | Create new tab |
| `tabs_context_mcp` | Get tab info |

### Workflow Orchestration

| Tool | Description |
|------|-------------|
| `workflow_init` | Initialize parallel workflow |
| `workflow_status` | Check progress |
| `workflow_collect` | Collect results |
| `workflow_cleanup` | Clean up resources |

---

## CLI Commands

```bash
ccp serve              # Start MCP server (auto-run by Claude Code)
ccp check              # Check Chrome connection
ccp status             # View session status
ccp status --json      # JSON output
ccp doctor             # Diagnose installation
ccp cleanup            # Clean up old sessions
ccp serve --port 9223  # Use custom port
```

---

## Performance

| Concurrent Sessions | Success Rate |
|:---:|:---:|
| 5 | 100% |
| 10 | 100% |
| 15 | 100% |
| 20 | 100% |

---

## Additional Features

### Network Simulation

```
You: Test myapp.com loading time on 3G network

Claude: [Applies 3G throttling: 1.5Mbps, 100ms latency]
```

Presets: `offline`, `slow-2g`, `2g`, `3g`, `4g`, `fast-wifi`, `custom`

### Config Recovery

```bash
# Auto-recover corrupted .claude.json
ccp recover

# List backups
ccp recover --list-backups
```

### Session Isolation

```bash
# Run Claude with isolated config (prevents race conditions)
ccp launch
ccp launch -p "Your prompt"
```

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

## Use Cases

- **Business**: ERP/SaaS data extraction, invoice downloads, repetitive task automation
- **Research**: Login-required platform data collection, academic DB searches
- **Social Media**: Multi-account posting, message management, analytics
- **E-commerce**: Member price monitoring, inventory management, review responses
- **QA Testing**: Parallel scenario testing, network condition testing
- **Productivity**: Email organization, calendar management, bookmark management

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
