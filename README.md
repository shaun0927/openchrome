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

## The Solution

**Claude Chrome Parallel** solves this by implementing:

- **Direct CDP Connection**: Uses Chrome DevTools Protocol via puppeteer-core
- **Session Isolation**: Each Claude Code instance gets its own browser context
- **Independent Tab Management**: No shared state between sessions
- **Request Queuing**: Per-session request ordering prevents race conditions
- **MCP Compatible**: Drop-in replacement for Claude in Chrome tools

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Browser                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Session A  │  │  Session B  │  │  Session C  │              │
│  │   Tab 1     │  │   Tab 1     │  │   Tab 1     │              │
│  │   Tab 2     │  │   Tab 2     │  │             │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ CDP (WebSocket)
┌──────────────────────────┴──────────────────────────────────────┐
│                  claude-chrome-parallel                          │
│                      MCP Server                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Session A  │  │  Session B  │  │  Session C  │              │
│  │  Manager    │  │  Manager    │  │  Manager    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ stdio (JSON-RPC)
┌──────────────────────────┴──────────────────────────────────────┐
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Claude Code │  │ Claude Code │  │ Claude Code │              │
│  │  Terminal 1 │  │  Terminal 2 │  │  Terminal 3 │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### Master-Worker Architecture (v2.0)

For **true parallelism** across multiple terminal processes, v2.0 introduces a Master-Worker architecture:

```
┌─────────────────────────────────────────────────────────┐
│                   Master Process                         │
│                                                          │
│  ┌──────────────┐  ┌─────────────────┐                  │
│  │  CDPClient   │  │ SessionRegistry │                  │
│  │  (single)    │  │   (central)     │                  │
│  └──────────────┘  └─────────────────┘                  │
│                                                          │
│  ┌──────────────────────────────────┐                   │
│  │   IPC Server (Named Pipe/Socket) │                   │
│  └──────────────────────────────────┘                   │
└────────────────────┬────────────────────────────────────┘
                     │ IPC
       ┌─────────────┼─────────────┐
       │             │             │
   Worker A      Worker B      Worker C
   (MCP stdio)   (MCP stdio)   (MCP stdio)
   ↑             ↑             ↑
   Claude 1      Claude 2      Claude 3
```

**Key Benefits:**
- **Single Chrome Connection**: Master holds the only CDP connection
- **No Detached Errors**: Workers delegate to Master via IPC
- **Session Isolation**: Each worker gets isolated sessions
- **Auto-Start**: Workers automatically start Master if needed

**Modes:**
- `serve` (default): Worker mode, connects to Master
- `serve --master`: Master mode, holds Chrome connection
- `serve --standalone`: Original mode, direct Chrome connection

## Installation

### Prerequisites

- Node.js 18+
- Google Chrome

### Option 1: Install from npm (after publish)

```bash
npm install -g claude-chrome-parallel
```

### Option 2: Install from GitHub

```bash
npm install -g github:shaun0927/claude-chrome-parallel
```

### Option 3: Install from local clone

```bash
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel
npm install
npm run build
npm install -g .
```

### Configure Claude Code

Add to your Claude Code config file (`~/.claude.json`):

Find the `"mcpServers"` section and add `chrome-parallel`:

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "claude-chrome-parallel",
      "args": ["serve"]
    },
    ...existing servers...
  }
}
```

### Restart Claude Code

After configuration, **restart Claude Code** for changes to take effect.

Verify with `/mcp` command - you should see `chrome-parallel` in the server list.

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
- Creates its own browser tabs
- Manages independent CDP connections
- Queues requests to prevent conflicts

### CLI Commands

```bash
# Start as Worker (default, connects to Master via IPC)
claude-chrome-parallel serve

# Start as Master (holds Chrome connection, workers connect to it)
claude-chrome-parallel serve --master

# Start in standalone mode (original behavior, no Master/Worker)
claude-chrome-parallel serve --standalone

# Start with custom Chrome debugging port
claude-chrome-parallel serve --port 9223

# Check Chrome and Master status
claude-chrome-parallel check

# Show architecture information
claude-chrome-parallel info
```

### Available Tools

All standard Claude in Chrome tools are supported:

| Tool | Description |
|------|-------------|
| `tabs_context_mcp` | Get session's available tabs |
| `tabs_create_mcp` | Create new tab in session |
| `navigate` | Navigate to URL or use history |
| `read_page` | Read accessibility tree |
| `computer` | Click, type, screenshot, scroll |
| `form_input` | Fill form fields |
| `find` | Find elements by description |
| `javascript_tool` | Execute JavaScript |

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
    "arguments": { "action": "screenshot", "tabId": "ABC123" }
  }
}
```

### Session Isolation

Sessions are completely isolated:

- Session A cannot access tabs created by Session B
- Each session maintains its own element references
- Request queues are per-session

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
| Independent tabs | ❌ | ✅ |
| Request queuing | ❌ | ✅ |
| MCP compatible | ✅ | ✅ |
| No extension needed | ❌ | ✅ |
| Auto Chrome launch | ❌ | ✅ |

## Chrome Configuration

By default, the package connects to Chrome on port 9222. If Chrome is not running with remote debugging, the package will attempt to start it automatically.

To manually start Chrome with remote debugging:

```bash
# Windows
chrome.exe --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

## Troubleshooting

### Chrome not connecting

```bash
# Check if Chrome is running with remote debugging
claude-chrome-parallel check

# Start Chrome manually with debugging enabled
chrome --remote-debugging-port=9222
```

### Session conflicts (should not happen)

If you experience session conflicts, the isolation may not be working correctly. Please report an issue.

## Development

```bash
# Clone repository
git clone https://github.com/shaun0927/claude-chrome-parallel.git
cd claude-chrome-parallel

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run E2E tests
npx ts-node scripts/e2e-test.ts
npx ts-node scripts/parallel-test.ts
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
- [Claude Code](https://github.com/anthropics/claude-code) for the amazing CLI
- [Puppeteer](https://pptr.dev/) for the browser automation library
