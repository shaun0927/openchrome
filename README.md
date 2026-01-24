# Claude Chrome Parallel

> **Run multiple Claude Code sessions with browser automation - no more "Detached" errors.**

[![npm version](https://badge.fury.io/js/claude-chrome-parallel.svg)](https://www.npmjs.com/package/claude-chrome-parallel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Problem

When using [Claude in Chrome](https://claude.ai/chrome) extension with multiple Claude Code sessions, you encounter:

```
Error: Detached while handling command
```

This happens because the Chrome extension uses **shared internal state**. When Session A takes a screenshot, Session B's connection gets "detached."

## The Solution

**Claude Chrome Parallel** solves this by using puppeteer-core to create **independent CDP connections** for each Claude Code session:

```
Claude Code 1 ──► puppeteer process 1 ──► CDP connection 1 ──┐
                                                              ├──► Chrome (port 9222)
Claude Code 2 ──► puppeteer process 2 ──► CDP connection 2 ──┘
```

Each session gets:
- ✅ Independent MCP server process
- ✅ Separate Chrome DevTools Protocol connection
- ✅ Isolated browser tabs
- ✅ No shared state = No conflicts

### Tested Concurrency

| Sessions | Success Rate |
|----------|-------------|
| 5 | 100% ✓ |
| 10 | 100% ✓ |
| 15 | 100% ✓ |
| 20 | 100% ✓ |

## Installation

### Prerequisites

- Node.js 18+
- Google Chrome

### Install from npm

```bash
npm install -g claude-chrome-parallel
```

### Install from GitHub

```bash
npm install -g github:shaun0927/claude-chrome-parallel
```

### Configure Claude Code

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

Restart Claude Code for changes to take effect.

## Usage

### Basic Usage

Once installed, use browser automation in any Claude Code session:

```
You: Take a screenshot of https://github.com

Claude: [Uses chrome-parallel tools automatically]
```

### Multiple Sessions

Run multiple Claude Code terminals simultaneously:

```bash
# Terminal 1
claude
> Take a screenshot of github.com

# Terminal 2 (at the same time!)
claude
> Take a screenshot of google.com
```

Both work without conflicts! 🎉

### CLI Commands

```bash
# Start MCP server (used by Claude Code automatically)
claude-chrome-parallel serve

# Check Chrome status
claude-chrome-parallel check

# Show how it works
claude-chrome-parallel info

# Use custom Chrome port
claude-chrome-parallel serve --port 9223
```

### Available Tools

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

## How It Works

### Why Chrome Extension Has Issues

The official Chrome extension maintains a **single shared state**:

```
Claude Code 1 ─┐
               ├─► Chrome Extension (shared state) ─► Chrome
Claude Code 2 ─┘
                    ↑
              State conflicts here!
```

### Why This Package Works

Each process has its own connection:

```
Claude Code 1 ─► Process 1 ─► CDP Connection 1 ─┐
                                                 ├─► Chrome
Claude Code 2 ─► Process 2 ─► CDP Connection 2 ─┘

Independent connections, no shared state!
```

Chrome's DevTools Protocol natively supports multiple simultaneous connections.

## Chrome Configuration

By default, connects to Chrome on port 9222.

**Auto-launch**: If Chrome isn't running with debugging, the package will start it automatically.

**Manual start** (if needed):

```bash
# Windows
chrome.exe --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

## Comparison

| Feature | Claude in Chrome (Extension) | Claude Chrome Parallel |
|---------|------------------------------|----------------------|
| Multiple sessions | ❌ Detached errors | ✅ Works perfectly |
| Connection type | Shared extension state | Independent CDP |
| Max sessions | 1 | 20+ tested |
| Auto Chrome launch | ❌ | ✅ |
| MCP compatible | ✅ | ✅ |

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

## Development

```bash
# Clone
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel

# Install & build
npm install
npm run build

# Test locally
npm install -g .
```

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
