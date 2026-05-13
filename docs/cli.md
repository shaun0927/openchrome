# OpenChrome CLI

## `oc run`

`oc run <tool> [--arg key=value ...] [--json]` executes one MCP tool through the same stdio MCP server used by MCP hosts. The CLI spawns `dist/index.js serve --server-mode`, performs the MCP initialize handshake, calls `tools/list` to validate the tool name, then sends one `tools/call` request.

Examples:

```bash
oc run navigate --arg url=https://example.com
oc run read_page --arg mode=dom --json
oc run page_screenshot --arg path=/tmp/page.png
oc run oc_assert --arg contract=json:'{"type":"text","contains":"Example Domain"}' --json
```

Argument values use this grammar:

- `--arg key=value` can be repeated.
- `true` and `false` become booleans.
- `json:<value>` parses `<value>` as JSON.
- Other values remain strings.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Tool returned a non-error MCP result. |
| 1 | Tool returned `isError: true`. |
| 2 | CLI usage error, including malformed `--arg` or unknown tool. |
| 3 | Transport/server failure. |

`--json` prints the raw MCP tool result. Without `--json`, the first text content item is printed when present.

`--reuse` connects to a running Streamable HTTP daemon at `OPENCHROME_HTTP_HOST`/`OPENCHROME_HTTP_PORT` (defaults: `127.0.0.1:3100`). If the daemon requires the legacy bearer token, set `OPENCHROME_AUTH_TOKEN` so the CLI can send `Authorization: Bearer ...`. If no daemon is reachable, the command exits 3 with a transport error instead of silently spawning a new server.

## Sugar commands

Common tools have positional aliases that call `oc run` internally. Additional `--arg` values override positional values.

| Command | Equivalent |
| --- | --- |
| `oc navigate URL` | `oc run navigate --arg url=URL` |
| `oc tabs_create URL` | `oc run tabs_create --arg url=URL` |
| `oc read_page` | `oc run read_page` |
| `oc page_screenshot PATH` | `oc run page_screenshot --arg path=PATH` |
| `oc tabs_context` | `oc run tabs_context` |
| `oc tabs_close TAB_ID` | `oc run tabs_close --arg tabId=TAB_ID` |
| `oc wait_for SELECTOR` | `oc run wait_for --arg selector=SELECTOR` |
| `oc click REF` | `oc run click --arg ref=REF` |
| `oc interact REF ACTION` | `oc run interact --arg ref=REF --arg action=ACTION` |
| `oc form_input REF VALUE` | `oc run form_input --arg ref=REF --arg value=VALUE` |
| `oc javascript_tool CODE` | `oc run javascript_tool --arg code=CODE` |
| `oc oc_assert CONTRACT_JSON` | `oc run oc_assert --arg contract=json:CONTRACT_JSON` |

Each invocation pays Node + server bootstrap cost. For repeated high-frequency browser work, prefer a long-running MCP host or future daemon reuse.
