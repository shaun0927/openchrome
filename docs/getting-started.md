# Getting Started with OpenChrome

OpenChrome is an MCP server that enables multiple Claude Code sessions to control Chrome simultaneously without "Detached" errors.

## Prerequisites

- Node.js >= 18
- Google Chrome (stable or Chromium)

## Installation

```bash
npm install -g openchrome-mcp
```

## Quick Start

1. Start Chrome with remote debugging enabled:

```bash
google-chrome --remote-debugging-port=9222
```

2. Add OpenChrome to your Claude Code MCP config (`~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "openchrome",
      "args": ["serve"]
    }
  }
}
```

3. Or use auto-launch (Chrome starts automatically):

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "openchrome",
      "args": ["serve", "--auto-launch"]
    }
  }
}
```

## Troubleshooting

When OpenChrome fails to start or behaves unexpectedly, run the built-in diagnostic command:

```bash
openchrome doctor
```

This checks your entire environment in one pass and prints an actionable report:

```
=== openchrome doctor ===

[  ok  ] Node.js version  v20.11.0 (required: >=18.0.0)
[  ok  ] ~/.openchrome/ writable  /Users/you/.openchrome
[ fail ] Chrome binary  Chrome executable not found on this system
         Fix: Install Google Chrome, or set CHROME_PATH env var to the binary path
[  ok  ] CDP port 9222  Port 9222 is free
[  ok  ] PID lock file  No PID file at /tmp/openchrome-9222.pid
[  ok  ] Orphaned Chrome processes  No orphaned openchrome-managed Chrome processes found
[  ok  ] Chrome profile lock  No lock files in /Users/you/Library/Application Support/Google/Chrome
[  ok  ] Disk space  18432 MB free on /Users/you/.openchrome filesystem
[ skip ] macOS permissions (TCC)  TCC.db not readable (Full Disk Access not granted — this is normal)
[  ok  ] Local network (loopback)  localhost → 127.0.0.1; loopback TCP ok
[ skip ] Optional native deps  No optional dependencies declared

Doctor: 8 ok, 0 warn, 1 fail, 2 skip
```

### Sample failure → fix transitions

**Chrome binary not found**

```
[ fail ] Chrome binary  Chrome executable not found on this system
         Fix: Install Google Chrome, or set CHROME_PATH env var to the binary path
```

Fix: Install Chrome from https://www.google.com/chrome, or point to your Chrome binary:

```bash
export CHROME_PATH=/path/to/chrome
openchrome doctor
```

**Stale PID lock from a crashed session**

```
[ fail ] PID lock file  Stale PID(s) 99999 in /tmp/openchrome-9222.pid (no live process)
         Fix: Remove stale lock: rm /tmp/openchrome-9222.pid  (or run: openchrome reap)
```

Fix: Remove the stale lock file:

```bash
rm /tmp/openchrome-9222.pid
# or
openchrome reap
```

**CDP port already in use by another process**

```
[ warn ] CDP port 9222  Port 9222 is in use (held by PID 12345) but no CDP endpoint found
         Fix: Free port 9222 or set CHROME_PORT to a different port
```

Fix: Either stop the process holding the port, or use a different port:

```bash
# Kill the holder
kill 12345
# Or use a different port
CHROME_PORT=9223 openchrome serve
```

### Machine-readable output

For scripting or CI, use `--json` to get a structured `DoctorReport`:

```bash
openchrome doctor --json | jq '.summary'
```

### Run a single check

Use `--check <id>` (repeatable) to run only specific checks:

```bash
openchrome doctor --check chrome-binary --check chrome-port
```

### Remote network probe (opt-in)

To also test outbound connectivity (disabled by default to avoid implicit outbound requests):

```bash
openchrome doctor --remote
```

### All available checks

| ID | What it checks |
|---|---|
| `node-version` | Node.js meets `engines.node` requirement |
| `home-writable` | `~/.openchrome/` exists and is writable |
| `chrome-binary` | Chrome binary found and reports a supported version |
| `chrome-port` | CDP port 9222 is free or hosts a live CDP endpoint |
| `pid-lock` | PID lock file is absent or owned by a live process |
| `orphan-chrome` | No openchrome-managed Chrome processes are orphaned |
| `profile-lock` | Chrome profile directory is not locked by another Chrome |
| `disk-space` | Free space on `~/.openchrome/` filesystem ≥ 500 MB |
| `macos-perms` | (macOS) Screen Recording / Accessibility hint for headed Chrome |
| `network-local` | Loopback DNS and TCP work correctly |
| `network-remote` | (opt-in) Outbound HTTPS to googleapis.com works |
| `optional-deps` | Optional native modules load correctly |

Exit codes: `0` = all ok, `1` = warnings only, `2` = at least one failure.
