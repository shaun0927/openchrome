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
A single-page walkthrough from installation to running your first verifiable
contract and recalling your first skill. Targets v1.11+.

## 1. Install

```bash
npm install -g openchrome-mcp@latest
openchrome --version    # should print 1.11.1 or newer
openchrome setup        # auto-configures your MCP client (Claude Code by default)
```

For other MCP clients:

```bash
openchrome setup --client codex      # Codex CLI
openchrome setup --client opencode   # OpenCode
```

Restart your MCP client. That's it for the core install — the next sections
are optional.

For manual Codex CLI setup, run `openchrome config --client codex` and add
the printed `[mcp_servers.openchrome]` block to `~/.codex/config.toml`.

## 2. Confirm core tier is live

Open a fresh chat in your MCP client and ask it to navigate somewhere:

```
"oc navigate https://example.com and read the page title"
```

You should see the agent call `navigate` and `read_page`. The default v1.11
install brings four extra MCP tools beyond v1.10:

- `oc_assert` — run a single contract assertion against page state
- `oc_evidence_bundle` — capture DOM + screenshot + network + console snapshot
- `oc_skill_record` — store a reusable skill record
- `oc_skill_recall` — retrieve skill records for a domain

…plus one new MCP resource: `openchrome://skill-graph/<domain>` (read-only).

## 3. Your first contract

A contract is a small JSON declaring what "success" looks like on a page.
Below is a minimal example you can pass inline to `oc_assert`:

```json
{
  "id": "homepage_loaded",
  "domain": "example.com",
  "assertions": [
    { "kind": "url", "equals": "https://example.com/" },
    { "kind": "dom_count", "selector": "h1", "gte": 1 },
    { "kind": "dom_text", "selector": "h1", "contains": "Example Domain" }
  ]
}
```

Ask your agent:

```
"oc, navigate to https://example.com then oc_assert this contract"
```

Expected verdict: `pass`. If you change `dom_text` to look for
`"Different Domain"`, the verdict is `fail` and `failed_assertions` shows
exactly which check failed and what was actually observed.

## 4. Capture an evidence bundle

When you want a richer record of page state (for debugging or for replay):

```
"oc, run oc_evidence_bundle with include=['dom','screenshot','network','phash']"
```

Returns:

```json
{
  "bundle_id": "evb_2026-05-12T05-30-22_abc123",
  "path": "/Users/<you>/.openchrome/evidence/evb_.../",
  "size_bytes": 184320,
  "parts": ["dom.txt", "screenshot.png", "network.jsonl", "phash.txt"]
}
```

The bundle directory is a flat collection of files. No SQL or special tooling
needed to inspect them.

## 5. Record and recall a skill

Skills are reusable named recipes for accomplishing a goal on a domain:

```
"oc, on https://example.com, save a skill named 'open-homepage' with these steps:
 1. navigate to https://example.com
 2. wait for h1
 3. oc_assert {<homepage_loaded contract>}"
```

The agent calls `oc_skill_record({ domain, name, steps, contract_id })`. Later:

```
"oc, oc_skill_recall for example.com"
```

Returns up to 20 skills for the domain, ordered by recency.

## 6. Inspect the skill graph

The skill state graph is a read-only MCP resource:

```
openchrome://skill-graph/example.com
```

Any MCP client that supports resources can subscribe / fetch the JSON
snapshot. Useful for dashboards or for the agent to plan a multi-step
recovery path.

## 7. (Optional) Enable the pilot tier

Pilot adds: contract runtime with retry, handoff token + encrypted
persistence, multi-model voting framework, and a background skill curator.

Edit your MCP client config to add `--pilot`:

```json
{
  "mcpServers": {
    "openchrome": {
      "command": "openchrome",
      "args": ["serve"]
      "args": ["serve", "--auto-launch", "--pilot"]
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
Restart your MCP client. When the server boots, **stderr** prints:

```
[harness] core+pilot enabled (trace,state_graph,contract_runtime,handoff_persist,perception_voting,skill_curator)
```

You can turn an individual family off without losing the rest:

```bash
OPENCHROME_PERCEPTION_VOTING=0 openchrome serve --pilot
```

## 8. (Optional) Persist handoff tokens across restarts

By default, the pilot handoff persistence layer uses an **ephemeral** key
generated at boot. Persisted tokens are invalidated on every restart, which
is the safer default for laptops and CI.

For long-running servers where cross-restart persistence matters, point at
a key file you manage:

```bash
# Generate a 32-byte key once
openssl rand -out ~/.openchrome/handoff-key.bin 32
chmod 600 ~/.openchrome/handoff-key.bin

# Tell the server to use it
export OPENCHROME_HANDOFF_KEY_FILE=~/.openchrome/handoff-key.bin
openchrome serve --pilot
```

The file is never logged and never embedded in audit records. If the file
size is anything other than exactly 32 bytes, the server falls back to
ephemeral mode and prints a warning to stderr.

## 9. Update later

```bash
openchrome update
```

This runs `npm install -g openchrome-mcp@latest` and re-runs setup against
your MCP client config so the runtime path stays in sync.

## What next

- [`docs/architecture.md`](architecture.md) — one-page overview of the
  core / pilot tier split and where each subsystem lives
- [`docs/roadmap/portability-harness-contract.md`](roadmap/portability-harness-contract.md) —
  the durable design contract every future PR must satisfy
- [`docs/releases/v1.11.1.md`](releases/v1.11.1.md) — full release notes
  with the cumulative v1.10.4 → v1.11.1 diff
- `openchrome doctor` — diagnose installation issues
