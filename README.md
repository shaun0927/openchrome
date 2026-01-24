# Claude Chrome Parallel

> **Run multiple Claude Code sessions safely - no more "Detached" errors or config corruption.**

[![npm version](https://badge.fury.io/js/claude-chrome-parallel.svg)](https://www.npmjs.com/package/claude-chrome-parallel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Session Isolation**: Prevents `.claude.json` corruption when running multiple Claude instances
- **Browser Automation**: Independent CDP connections for parallel browser control
- **Auto Recovery**: Detects and recovers corrupted config files

---

## Problem 1: Config File Corruption

When running **multiple Claude Code instances** simultaneously, they compete to write to `~/.claude.json`, causing corruption:

```
Terminal 1: claude  ──┐
                      ├──► ~/.claude.json ← Race condition!
Terminal 2: claude  ──┘

Result: {"key":"value"}{"key":"value"}  ← Two JSON objects concatenated = CORRUPT
```

**Symptoms:**
- Claude Code crashes on startup
- "Unexpected token" JSON parse errors
- Lost settings and preferences

## Solution: Session Isolation

```bash
# Instead of running claude directly...
claude-chrome-parallel launch

# Each session gets isolated config
Terminal 1: claude-chrome-parallel launch  ──► ~/.claude-chrome-parallel/sessions/abc123/.claude.json
Terminal 2: claude-chrome-parallel launch  ──► ~/.claude-chrome-parallel/sessions/def456/.claude.json
```

**All your existing flags work:**

```bash
claude-chrome-parallel launch --dangerously-skip-permissions
claude-chrome-parallel launch --resume abc123
claude-chrome-parallel launch -p "Fix the bug"
claude-chrome-parallel launch --model opus --resume
```

---

## Problem 2: Browser "Detached" Errors

When using browser automation with multiple sessions:

```
Error: Detached while handling command
```

The Chrome extension uses **shared internal state** - when Session A takes a screenshot, Session B's connection breaks.

## Solution: Independent CDP Connections

```
Claude Code 1 ──► puppeteer process 1 ──► CDP connection 1 ──┐
                                                              ├──► Chrome
Claude Code 2 ──► puppeteer process 2 ──► CDP connection 2 ──┘
```

---

## Installation

### Prerequisites

- Node.js 18+
- Google Chrome (for browser automation)

### Install

```bash
# From npm
npm install -g claude-chrome-parallel

# Or from GitHub
npm install -g github:shaun0927/claude-chrome-parallel
```

---

## Usage

### Session Isolation (Recommended for Multiple Instances)

```bash
# Start Claude Code with isolated config
claude-chrome-parallel launch

# Pass any claude flags
claude-chrome-parallel launch --dangerously-skip-permissions
claude-chrome-parallel launch --resume <session-id>
claude-chrome-parallel launch -p "Your prompt here"

# Sync changes back to original config on exit
claude-chrome-parallel launch --sync-back

# Keep session directory for debugging
claude-chrome-parallel launch --keep-session
```

### Standalone Wrapper (Alternative)

```bash
# Simpler command
claude-session

# With arguments
claude-session "Fix the authentication bug"
claude-session --list      # List active sessions
claude-session --cleanup   # Clean up stale sessions
claude-session --recover   # Recover corrupted config
```

### Recovery Commands

```bash
# Check config health
claude-chrome-parallel doctor

# Auto-recover corrupted .claude.json
claude-chrome-parallel recover

# List available backups
claude-chrome-parallel recover --list-backups

# Restore from specific backup
claude-chrome-parallel recover --backup ".claude.json.2024-01-15T10-30-00-000Z.bak"

# Force create new empty config
claude-chrome-parallel recover --force-new

# Clean up old sessions and backups
claude-chrome-parallel cleanup
claude-chrome-parallel cleanup --max-age 12      # Sessions older than 12 hours
claude-chrome-parallel cleanup --keep-backups 5  # Keep only 5 most recent backups
```

### Browser Automation (MCP Server)

Add to `~/.claude.json`:

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

Then use in Claude Code:

```
You: Take a screenshot of https://github.com

Claude: [Uses chrome-parallel tools automatically]
```

**Run multiple sessions with browser automation:**

```bash
# Terminal 1
claude-chrome-parallel launch
> Take a screenshot of github.com

# Terminal 2 (simultaneously!)
claude-chrome-parallel launch
> Take a screenshot of google.com
```

Both work without conflicts!

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `launch [args...]` | Start Claude with isolated config |
| `recover` | Recover corrupted .claude.json |
| `cleanup` | Clean up stale sessions and backups |
| `doctor` | Check installation and config health |
| `serve` | Start MCP server for browser automation |
| `install` | Install browser extension and native host |
| `uninstall` | Remove extension and native host |

### Launch Options

| Option | Description |
|--------|-------------|
| `--sync-back` | Sync config changes back to original on exit |
| `--keep-session` | Keep session directory after exit (debugging) |

### Recover Options

| Option | Description |
|--------|-------------|
| `--list-backups` | List available backup files |
| `--backup <name>` | Restore from specific backup |
| `--force-new` | Create new empty config (loses all data) |

### Cleanup Options

| Option | Description |
|--------|-------------|
| `--max-age <hours>` | Max session age in hours (default: 24) |
| `--keep-backups <n>` | Number of backups to keep (default: 10) |

---

## Browser Automation Tools

| Tool | Description |
|------|-------------|
| `navigate` | Navigate to URL or use history |
| `tabs_context_mcp` | Get available tabs |
| `tabs_create_mcp` | Create new tab |
| `computer` | Screenshots, mouse/keyboard, scrolling |
| `read_page` | Read accessibility tree |
| `find` | Find elements by description |
| `form_input` | Fill form fields |
| `javascript_tool` | Execute JavaScript |

---

## How It Works

### Session Isolation

```
Before (Dangerous):
┌─────────────────────────────────────────────┐
│ Terminal 1: claude ──┐                      │
│                      ├─► ~/.claude.json     │ ← Race condition!
│ Terminal 2: claude ──┘                      │
└─────────────────────────────────────────────┘

After (Safe):
┌─────────────────────────────────────────────┐
│ Terminal 1: launch ─► sessions/abc/.claude.json │
│                                                 │ ← No conflict!
│ Terminal 2: launch ─► sessions/def/.claude.json │
└─────────────────────────────────────────────┘
```

The `launch` command:
1. Creates a unique session directory
2. Copies existing `.claude.json` (if valid)
3. Sets `HOME` environment variable to session directory
4. Runs `claude` with all your arguments
5. Cleans up session on exit

### Browser Automation

Chrome's DevTools Protocol natively supports multiple connections:

```
Process 1 ─► CDP Connection 1 ─┐
                               ├─► Chrome (port 9222)
Process 2 ─► CDP Connection 2 ─┘
```

---

## Troubleshooting

### Config Corruption

```bash
# Check health
claude-chrome-parallel doctor

# If corrupted, recover
claude-chrome-parallel recover
```

### Chrome Not Connecting

```bash
# Check status
claude-chrome-parallel check

# Manually start Chrome with debugging
chrome --remote-debugging-port=9222
```

### Tools Not Appearing

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

## Comparison

| Feature | Plain `claude` | `claude-chrome-parallel launch` |
|---------|----------------|--------------------------------|
| Multiple instances | Config corruption risk | Safe (isolated) |
| Browser automation | Detached errors | Works perfectly |
| Auto backup | | Config backed up |
| Recovery tools | | Built-in |

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
