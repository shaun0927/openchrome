# Claude Chrome Parallel

> **Run multiple Claude Code browser sessions in parallel - no more "Detached" errors.**

[![npm version](https://badge.fury.io/js/claude-chrome-parallel.svg)](https://www.npmjs.com/package/claude-chrome-parallel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why This Exists

[Claude Chrome](https://claude.ai/chrome) is a powerful tool that lets you debug **production environments while logged in** - no need to replicate auth states or mock sessions. But when you try to run multiple Claude Code sessions with browser automation simultaneously, you get:

```
Error: Detached while handling command
```

This happens because the Chrome extension uses **shared internal state**. When Session A takes a screenshot, Session B's connection gets "detached."

**Claude Chrome Parallel** solves this by creating **independent CDP connections** for each session:

```
Claude Code 1 ──► Process 1 ──► CDP Connection 1 ──┐
                                                    ├──► Chrome (port 9222)
Claude Code 2 ──► Process 2 ──► CDP Connection 2 ──┘
```

Each session gets isolated browser control. No shared state = No conflicts.

---

## Use Cases

### Multi-Session QA Testing

Run parallel test scenarios against your production or staging environment:

```bash
# Terminal 1: Test user login flow
claude -p "Test the login flow on https://myapp.com/login"

# Terminal 2: Test checkout process (simultaneously!)
claude -p "Test the checkout flow on https://myapp.com/cart"

# Terminal 3: Monitor admin dashboard
claude -p "Take screenshots of https://myapp.com/admin every 30 seconds"
```

### Parallel Debugging

Debug multiple pages or user journeys at the same time:

```bash
# Debug as different users
Terminal 1: "Log in as admin and check permissions on /settings"
Terminal 2: "Log in as regular user and verify they can't access /settings"
```

### Automated Regression Testing

Run comprehensive browser tests across multiple sessions:

```bash
# Run 5 parallel test sessions
for i in {1..5}; do
  claude -p "Run test suite $i on https://staging.myapp.com" &
done
```

### Tested Concurrency

| Sessions | Success Rate |
|----------|-------------|
| 5 | 100% |
| 10 | 100% |
| 15 | 100% |
| 20 | 100% |

---

## Installation

```bash
# From npm
npm install -g claude-chrome-parallel

# Or from GitHub
npm install -g github:shaun0927/claude-chrome-parallel
```

### Configure Claude Code

Add to your Claude Code MCP settings (`~/.claude.json`):

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "claude-chrome-parallel",
      "args": ["serve"]
    }
  }
}
```

Restart Claude Code for changes to take effect.

---

## Usage

### Basic Usage

Once configured, browser automation works in any Claude Code session:

```
You: Take a screenshot of https://github.com

Claude: [Uses chrome-parallel tools automatically]
```

### Multiple Parallel Sessions

Run multiple Claude Code terminals simultaneously:

```bash
# Terminal 1
claude
> Navigate to myapp.com/dashboard and take a screenshot

# Terminal 2 (at the same time!)
claude
> Fill out the form on myapp.com/contact and submit

# Terminal 3 (also at the same time!)
claude
> Monitor network requests on myapp.com/api
```

All sessions work without conflicts!

### Available Browser Tools

| Tool | Description |
|------|-------------|
| `navigate` | Navigate to URL or use history |
| `computer` | Screenshots, mouse clicks, keyboard input, scrolling |
| `read_page` | Read page content via accessibility tree |
| `find` | Find elements by description |
| `form_input` | Fill form fields |
| `javascript_tool` | Execute JavaScript |
| `tabs_context_mcp` | Get available tabs |
| `tabs_create_mcp` | Create new tab |
| `network` | Simulate network conditions (3G, 4G, offline, custom) |

### Network Simulation

Test how your app behaves under different network conditions:

```
You: Simulate 3G network and navigate to myapp.com

Claude: [Applies 3G throttling: 1.5Mbps down, 750Kbps up, 100ms latency]
```

Available presets: `offline`, `slow-2g`, `2g`, `3g`, `4g`, `fast-wifi`, `custom`, `clear`

---

## How It Works

### The Problem: Shared Extension State

The official Chrome extension maintains a single shared state:

```
Claude Code 1 ─┐
               ├─► Chrome Extension (shared state) ─► Chrome
Claude Code 2 ─┘
                    ↑
              State conflicts here!
```

### The Solution: Independent CDP Connections

Chrome's DevTools Protocol natively supports multiple simultaneous connections:

```
Claude Code 1 ─► Process 1 ─► CDP Connection 1 ─┐
                                                 ├─► Chrome (port 9222)
Claude Code 2 ─► Process 2 ─► CDP Connection 2 ─┘

Independent connections, no shared state!
```

Each Claude Code session spawns its own MCP server process with a dedicated CDP connection.

---

## CLI Commands

```bash
# Start MCP server (used by Claude Code automatically)
claude-chrome-parallel serve

# Check Chrome connection status
claude-chrome-parallel check

# Use custom Chrome debugging port
claude-chrome-parallel serve --port 9223

# Check installation health
claude-chrome-parallel doctor

# View session status and statistics
claude-chrome-parallel status

# View status as JSON (for automation)
claude-chrome-parallel status --json

# Clean up stale sessions and old backups
claude-chrome-parallel cleanup --max-age 24 --keep-backups 10
```

---

## Chrome Configuration

By default, connects to Chrome on port 9222.

**Auto-launch**: If Chrome isn't running with debugging enabled, the package will start it automatically.

**Manual start** (if needed):

```bash
# Windows
chrome.exe --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

---

## Additional Features

### Session Isolation (Bonus)

When running multiple Claude Code instances, they can corrupt `~/.claude.json` due to race conditions. Use the `launch` command to run Claude with isolated config:

```bash
# Run Claude Code with isolated config directory
claude-chrome-parallel launch

# Pass any claude flags
claude-chrome-parallel launch --dangerously-skip-permissions
claude-chrome-parallel launch -p "Your prompt"
```

### Config Recovery

If your `.claude.json` gets corrupted:

```bash
# Auto-recover corrupted config
claude-chrome-parallel recover

# List available backups
claude-chrome-parallel recover --list-backups
```

---

## Comparison

| Feature | Claude in Chrome (Extension) | Claude Chrome Parallel |
|---------|------------------------------|----------------------|
| Multiple sessions | ❌ Detached errors | ✅ Works perfectly |
| Parallel QA testing | ❌ | ✅ |
| Connection type | Shared extension state | Independent CDP |
| Max concurrent sessions | 1 | 20+ tested |
| Auto Chrome launch | ❌ | ✅ |
| Network simulation | ❌ | ✅ 3G/4G/offline presets |
| Session auto-cleanup | ❌ | ✅ TTL-based |
| Connection pooling | ❌ | ✅ Pre-warmed pages |

---

## Troubleshooting

### Chrome not connecting

```bash
# Check status
claude-chrome-parallel check

# Manually start Chrome with debugging
chrome --remote-debugging-port=9222
```

### Tools not appearing in Claude Code

1. Check MCP config in `~/.claude.json`
2. Restart Claude Code
3. Run `/mcp` to verify `chrome-parallel` is listed

---

## Development

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel

npm install
npm run build

# Test locally
npm install -g .
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

## Disclaimer

> **This is an unofficial, community-maintained project.**
> Not affiliated with or endorsed by Anthropic.
>
> "Claude" is a trademark of Anthropic. This project provides
> tooling to enhance the Claude Code experience but is not
> an official Anthropic product.

## Acknowledgments

- [Anthropic](https://anthropic.com) for Claude and the MCP protocol
- [Claude Code](https://github.com/anthropics/claude-code) for the CLI
- [Puppeteer](https://pptr.dev/) for browser automation
