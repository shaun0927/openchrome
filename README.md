# Claude Chrome Parallel

> **Run multiple Claude Code sessions with independent browser automation - no more "Detached" errors.**

[![npm version](https://badge.fury.io/js/claude-chrome-parallel.svg)](https://www.npmjs.com/package/claude-chrome-parallel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Problem

When using [Claude in Chrome](https://claude.ai/chrome) with multiple Claude Code sessions, you encounter:

```
Error: Detached while handling command
```

This happens because the official extension uses a **single shared state** for all sessions. When Session A takes a screenshot, Session B's connection gets "detached."

### Official Claude in Chrome: Pros & Cons

| Pros | Cons |
|------|------|
| ✅ Official Anthropic support | ❌ Single session only |
| ✅ Auto-updates via Chrome Web Store | ❌ Sessions conflict with each other |
| ✅ Easy one-click install | ❌ "Detached" errors in parallel workflows |
| ✅ Integrated with Claude Code | ❌ No session isolation |
| ✅ Native MCP protocol support | ❌ Cannot run concurrent browser automation |

## The Solution

**Claude Chrome Parallel** solves this by implementing:

- **Session Isolation**: Each Claude Code instance gets its own tab group
- **Independent CDP Connections**: No shared state between sessions
- **Request Queuing**: Per-session request ordering prevents race conditions
- **MCP Compatible**: Drop-in replacement for Claude in Chrome tools

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              Claude Chrome Parallel Extension                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Session Manager                              │    │
│  │  ┌─────────────┬─────────────┬─────────────────┐        │    │
│  │  │  Session A  │  Session B  │  Session C      │        │    │
│  │  │  TabGroup 1 │  TabGroup 2 │  TabGroup 3     │        │    │
│  │  │  CDP Conn 1 │  CDP Conn 2 │  CDP Conn 3     │        │    │
│  │  │  Queue 1    │  Queue 2    │  Queue 3        │        │    │
│  │  └─────────────┴─────────────┴─────────────────┘        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- Node.js 18+
- Google Chrome
- Claude Code CLI

### Install via npm

```bash
# Install globally
npm install -g claude-chrome-parallel

# Run installer (sets up extension + native messaging host)
claude-chrome-parallel install
```

### Manual Chrome Setup

After installation, you need to load the extension in Chrome:

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select `~/.claude-chrome-parallel/extension/`
5. Note the Extension ID for configuration

### Configure Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

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

## Usage

### Basic Usage

Once installed, Claude Code automatically uses session-isolated browser automation:

```
You: Take a screenshot of https://example.com

Claude: [Uses chrome-parallel tools with automatic session ID]
```

### Multiple Sessions

Run multiple Claude Code instances simultaneously:

```bash
# Terminal 1
claude

# Terminal 2
claude

# Terminal 3
claude
```

Each session automatically:
- Creates its own Chrome tab group
- Manages independent CDP connections
- Queues requests to prevent conflicts

### Available Tools

All standard Claude in Chrome tools are supported:

| Tool | Description |
|------|-------------|
| `tabs_context_mcp` | Get session's available tabs |
| `tabs_create_mcp` | Create new tab in session's group |
| `navigate` | Navigate to URL |
| `read_page` | Read accessibility tree |
| `computer` | Click, type, screenshot, scroll |
| `form_input` | Fill form fields |
| `find` | Find elements by description |
| `javascript_tool` | Execute JavaScript |
| `read_console_messages` | Read console logs |
| `read_network_requests` | Monitor network |
| `gif_creator` | Record browser actions as GIF |

## How It Works

### Session Identification

Each Claude Code process gets a unique session ID:

```typescript
// Automatically generated per Claude Code instance
const sessionId = crypto.randomUUID();

// All MCP requests include sessionId
{
  "method": "tools/call",
  "params": {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "name": "computer",
    "arguments": { "action": "screenshot", "tabId": 123 }
  }
}
```

### Tab Group Isolation

Sessions are isolated by Chrome Tab Groups:

```
┌─────────────────────────────────────────────────────┐
│ Chrome Window                                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │ Session A    │ │ Session B    │ │ Session C    │ │
│  │ [Tab1][Tab2] │ │ [Tab3][Tab4] │ │ [Tab5]       │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Request Queuing

Per-session FIFO queues prevent race conditions:

```typescript
// Session A's queue
Queue A: [screenshot] → [click] → [type]

// Session B's queue (independent)
Queue B: [navigate] → [read_page]
```

## Comparison with Official Extension

| Feature | Claude in Chrome | Claude Chrome Parallel |
|---------|-----------------|----------------------|
| Parallel sessions | ❌ | ✅ |
| Session isolation | ❌ | ✅ |
| Tab group per session | ❌ | ✅ |
| Independent CDP | ❌ | ✅ |
| Request queuing | ❌ | ✅ |
| MCP compatible | ✅ | ✅ |
| Auto-update | ✅ | Manual (npm update) |
| Chrome Web Store | ✅ | Developer mode |

## Troubleshooting

### Extension not loading

```bash
# Reinstall extension files
claude-chrome-parallel install --force
```

### Native messaging errors

```bash
# Check host registration
claude-chrome-parallel doctor
```

### Session conflicts

```bash
# List active sessions
claude-chrome-parallel sessions

# Clear stale sessions
claude-chrome-parallel sessions --clear
```

## Uninstallation

```bash
# Remove extension and native host
claude-chrome-parallel uninstall

# Remove npm package
npm uninstall -g claude-chrome-parallel
```

Then manually remove the extension from `chrome://extensions/`.

## Development

```bash
# Clone repository
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel

# Install dependencies
npm install

# Build extension
npm run build

# Run tests
npm test

# Development mode (watch)
npm run dev
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md).

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
- [Claude Code](https://github.com/anthropics/claude-code) for the amazing CLI
- The open-source community for inspiration and feedback
